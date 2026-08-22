import { spawn } from "node:child_process";
import { BaseAgent } from "./base.js";
import { cleanEnv } from "../util.js";
import { CLAUDE_EFFORT_TOKENS } from "../models.js";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

// Claude Code CLI adaptörü.
// Abonelik oturumu ile "claude -p --output-format json" çağırır;
// ana oturum sürekliliği --resume <session_id> ile sağlanır (API anahtarı yok).
// opts.fresh doğruysa taze oturum açar (paralel işçi kopyalar için).
export class ClaudeAgent extends BaseAgent {
  constructor(store, rootDir, opts = {}) {
    // Koordinatör de bu adaptörü ayrı bir isim ve ayrı bir oturumla kullanır.
    super(opts.name || "claude", store, rootDir);
    this.bin = opts.bin || "claude";
  }

  async invoke(prompt, opts = {}) {
    try {
      return await this._invoke(prompt, opts);
    } catch (err) {
      // Seçili model/çaba tanınmıyorsa varsayılan ayarlarla bir kez dene
      const model = opts.model ?? this.getModel?.();
      const effort = opts.effort ?? this.getEffort?.();
      if ((model || effort) && !opts._noModelRetry) {
        this.log(`model/çaba (${model}/${effort}) ile hata: ${err.message}; varsayılanlarla yeniden deneniyor`);
        return this._invoke(prompt, { ...opts, model: "", effort: "", _noModelRetry: true });
      }
      throw err;
    }
  }

  async _invoke(prompt, opts = {}) {
    // stream-json: hem canlı akış hem token kullanımı için JSONL olay akışı
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
    if (this.sessionId && !opts.fresh) {
      args.push("--resume", this.sessionId);
    }
    const model = opts.model ?? this.getModel?.();
    if (model) args.push("--model", model);
    if (opts.codeMode) {
      // Kod görevi: dosya düzenlemelerine izin ver, ama tehlikeli izinleri açma.
      args.push("--permission-mode", "acceptEdits");
    } else {
      // Tartışma/inceleme görevi: salt okunur çalışma.
      args.push("--disallowedTools", "Bash,Edit,Write,NotebookEdit");
    }

    let live = "";
    let result = null;
    const onLine = (line) => {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === "stream_event" && ev.event?.delta?.type === "text_delta") {
        live += ev.event.delta.text;
        this.progress(opts.label || "", live);
      } else if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
        const text = ev.message.content.filter((c) => c.type === "text").map((c) => c.text).join("");
        if (text) { live = text; this.progress(opts.label || "", live); }
      } else if (ev.type === "result") {
        result = ev;
      }
    };

    // Çaba seviyesi: düşünme bütçesi ortam değişkeniyle ayarlanır
    const effort = opts.effort ?? this.getEffort?.();
    const extraEnv = {};
    if (effort && CLAUDE_EFFORT_TOKENS[effort]) {
      extraEnv.MAX_THINKING_TOKENS = String(CLAUDE_EFFORT_TOKENS[effort]);
    }

    const { code, timedOut, stderr, stdout } = await this.spawnCollect(
      this.bin, args, prompt, opts.cwd, opts.timeoutMs, onLine, extraEnv
    );
    if (timedOut) throw new Error("Claude çağrısı zaman aşımına uğradı");
    if (!result) {
      throw new Error(`Claude çıktısı çözümlenemedi (exit ${code}): ${(stderr || stdout).slice(0, 400)}`);
    }
    if (result.session_id && !opts.fresh) this.sessionId = result.session_id;
    if (result.is_error) {
      throw new Error(`Claude hata döndürdü: ${String(result.result).slice(0, 400)}`);
    }
    const u = result.usage || {};
    const usage = {
      input: u.input_tokens || 0,
      cachedInput: (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      output: u.output_tokens || 0,
      costUsd: result.total_cost_usd || 0,
    };
    this.onUsage?.(usage);
    return { ok: true, text: result.result || "", raw: { session_id: result.session_id, usage } };
  }

  spawnCollect(bin, args, stdinText, cwd, timeoutMs = DEFAULT_TIMEOUT_MS, onLine = null, extraEnv = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, {
        cwd: cwd || this.rootDir,
        env: { ...cleanEnv(), ...extraEnv },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.children.add(child);
      let stdout = "", stderr = "", timedOut = false, lineBuf = "";
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch {}
      }, timeoutMs);
      child.stdout.on("data", (d) => {
        stdout += d;
        if (onLine) {
          lineBuf += d;
          const lines = lineBuf.split("\n");
          lineBuf = lines.pop();
          for (const l of lines) if (l.trim()) onLine(l.trim());
        }
      });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("error", (err) => { clearTimeout(timer); this.children.delete(child); reject(err); });
      child.on("close", (code) => {
        clearTimeout(timer);
        this.children.delete(child);
        if (onLine && lineBuf.trim()) onLine(lineBuf.trim());
        this.log(`claude exit=${code} args=${args.join(" ")}\nstderr: ${stderr.slice(0, 2000)}`);
        resolve({ stdout, stderr, code, timedOut });
      });
      child.stdin.write(stdinText);
      child.stdin.end();
    });
  }
}
