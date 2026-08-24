import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BaseAgent } from "./base.js";
import { cleanEnv, uid } from "../util.js";
import { CODEX_EFFORT } from "../models.js";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

// OpenAI Codex CLI adaptörü.
// ChatGPT abonelik girişi ile "codex exec --json" çağırır;
// ana oturum sürekliliği "codex exec resume <thread_id>" ile sağlanır.
// opts.fresh doğruysa taze oturum açar (paralel işçi kopyalar için).
export class CodexAgent extends BaseAgent {
  constructor(store, rootDir, opts = {}) {
    super("codex", store, rootDir);
    this.bin = opts.bin || "codex";
  }

  async invoke(prompt, opts = {}) {
    try {
      return await this._invoke(prompt, opts);
    } catch (err) {
      const message = String(err?.message || err);
      // Kullanıcı durdurduysa ASLA yeniden deneme
      if (opts.shouldStop?.()) throw err;
      // Süre sınırına ulaşan işi farklı model ayarlarıyla baştan çalıştırmak
      // gerçek sınırı katlayıp arayüzü takılmış gibi bırakır.
      if (/zaman aşım/i.test(message)) throw err;
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
    const lastMsgFile = path.join(this.rootDir, "runs", `codex-last-${uid()}.txt`);
    const model = opts.model ?? this.getModel?.();
    // Yerleşik web araması ve otomatik güvenlik incelemesi; kullanıcının mevcut
    // Codex MCP, eklenti ve skill yapılandırması aynen yüklenmeye devam eder.
    const common = ["--json", "--skip-git-repo-check", "-o", lastMsgFile];
    if (model) common.push("-m", model);
    const effort = opts.effort ?? this.getEffort?.();
    if (effort && CODEX_EFFORT[effort]) {
      common.push("-c", `model_reasoning_effort="${CODEX_EFFORT[effort]}"`);
    }
    for (const img of opts.images || []) {
      common.push("-i", img);
    }

    // Dikkat: "exec resume" alt komutu --sandbox ve -C bayraklarını KABUL ETMEZ;
    // resume'da sandbox -c config anahtarıyla verilir, çalışma dizini oturumda kalır.
    // --approve-for-me kendi workspace-write sandbox'ını kurar ve --sandbox ile
    // birlikte kullanılamaz.
    const freshArgs = ["--search", "exec", "--approve-for-me", ...common];
    if (opts.cwd) freshArgs.push("-C", opts.cwd);

    const sess = opts.fresh ? null : this.getSession(opts);
    const useResume = !!sess;
    let args = useResume
      ? ["--search", "exec", "resume", ...common,
          "-c", 'approval_policy="never"', "-c", 'sandbox_mode="workspace-write"',
          // Resume calisma dizinini surecten alir; sandbox'in yazilabilir koku
          // de acikca proje dizinine baglanir ki eski oturum yeni projeye
          // yazabilsin.
          ...(opts.cwd ? ["-c", `sandbox_workspace_write.writable_roots=[${JSON.stringify(opts.cwd)}]`] : []),
          sess]
      : freshArgs;

    // Canlı akış: olaylar geldikçe kısmi çıktıyı yayınla
    let live = "", text = "", usage = null;
    const onLine = (line) => {
      if (!line.startsWith("{")) return;
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === "thread.started" && ev.thread_id && !opts.fresh) {
        this.setSession(opts, ev.thread_id);
      } else if (ev.type === "item.completed" && ev.item) {
        if (ev.item.type === "agent_message") {
          text = ev.item.text || text;
          live += (live ? "\n" : "") + (ev.item.text || "");
        } else if (ev.item.type === "command_execution") {
          live += `\n$ ${ev.item.command || ""}`;
        } else if (ev.item.type === "reasoning" && ev.item.text) {
          live += `\n💭 ${String(ev.item.text).slice(0, 200)}`;
        }
        if (!opts.silent) this.progress(opts.label || "", live, opts.memberId);
      } else if (ev.type === "turn.completed" && ev.usage) {
        usage = ev.usage;
      }
    };

    let result = await this.spawnCollect(this.bin, args, prompt, opts.timeoutMs, onLine, opts.sessionKey, opts.cwd);
    if (result.timedOut) throw new Error("Codex çağrısı zaman aşımına uğradı");

    // Resume başarısız olursa (oturum bulunamadı vb.) taze oturumla tekrar dene
    if (result.code !== 0 && useResume) {
      if (opts.shouldStop?.()) throw new Error("Durduruldu");
      this.log("codex resume başarısız, yeni oturum deneniyor");
      this.clearSession(opts);
      live = ""; text = "";
      result = await this.spawnCollect(this.bin, freshArgs, prompt, opts.timeoutMs, onLine, opts.sessionKey, opts.cwd);
      if (result.timedOut) throw new Error("Codex çağrısı zaman aşımına uğradı");
    }
    if (result.code !== 0) {
      throw new Error(`Codex hata ile çıktı (exit ${result.code}): ${(result.stderr || result.stdout).slice(0, 400)}`);
    }
    // -o dosyası en güvenilir son mesaj kaynağı
    try {
      const fromFile = fs.readFileSync(lastMsgFile, "utf8").trim();
      if (fromFile) text = fromFile;
      fs.unlinkSync(lastMsgFile);
    } catch {}

    if (!text) throw new Error("Codex yanıtı boş döndü");
    const normUsage = usage ? {
      input: usage.input_tokens || 0,
      cachedInput: usage.cached_input_tokens || 0,
      output: usage.output_tokens || 0,
      costUsd: 0,
    } : null;
    if (normUsage) (opts.onUsage || this.onUsage)?.(normUsage);
    return { ok: true, text, raw: { thread_id: this.getSession(opts), usage: normUsage } };
  }

  spawnCollect(bin, args, stdinText, timeoutMs = DEFAULT_TIMEOUT_MS, onLine = null, sessionKey = null, cwd = null) {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, {
        // Calisma dizini surec seviyesinde verilir. "-C" bayragi yalniz taze
        // oturumda gecerlidir; "exec resume" onu kabul etmez. Yalniz -C'ye
        // guvenilirse resume edilen her cagri sunucunun kendi dizinine duser
        // ve workspace-write sandbox'i projeye yazmayi engeller.
        cwd: cwd || this.rootDir,
        env: cleanEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      });
      child._sessionKey = sessionKey || null;
      this.children.add(child);
      let stdout = "", stderr = "", timedOut = false, lineBuf = "";
      let forceKillTimer = null;
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch {}
        forceKillTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 4_000);
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
      child.on("error", (err) => { clearTimeout(timer); clearTimeout(forceKillTimer); this.children.delete(child); reject(err); });
      child.on("close", (code) => {
        clearTimeout(timer);
        clearTimeout(forceKillTimer);
        this.children.delete(child);
        if (onLine && lineBuf.trim()) onLine(lineBuf.trim());
        this.log(`codex exit=${code} args=${args.join(" ")}\nstderr: ${stderr.slice(0, 2000)}`);
        resolve({ stdout, stderr, code, timedOut });
      });
      child.stdin.write(stdinText);
      child.stdin.end();
    });
  }
}
