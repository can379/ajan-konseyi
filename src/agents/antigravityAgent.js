import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { BaseAgent } from "./base.js";
import { cleanEnv } from "../util.js";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

// Antigravity'nin resmi CLI motoru. Eski language_server RPC köprüsü yalnız
// sohbet üretimini açıyor, yerleşik terminal/tarayıcı/web/MCP/skill/alt ajan ve
// görsel üretim araçlarını devre dışı bırakıyordu. `agy` başsız çalışır; GUI'ye
// odaklanmaz ve conversation_id ile gerçek oturum sürekliliği sağlar.
export class AntigravityAgent extends BaseAgent {
  constructor(store, rootDir, opts = {}) {
    super("antigravity", store, rootDir);
    this.bin = opts.bin || "agy";
    this._cliReady = false;
    this.updateBridgeStatus();
  }

  isConnected() { return true; }
  isFresh() { return this._cliReady; }

  updateBridgeStatus() {
    if (this.store.agentStatus.antigravity?.status === "busy") return;
    this.store.setAgentStatus("antigravity", "idle", this._cliReady ? "native CLI bağlı" : "native CLI hazır");
  }

  async invoke(prompt, opts = {}) {
    try {
      return await this._invoke(prompt, opts);
    } catch (err) {
      if (opts.shouldStop?.()) throw err;
      if (this.getSession(opts) && !opts.fresh && !opts._noResumeRetry) {
        this.log(`conversation devamı başarısız (${err.message}); yeni oturum deneniyor`);
        this.clearSession(opts);
        return this._invoke(prompt, { ...opts, _noResumeRetry: true });
      }
      throw err;
    }
  }

  async _invoke(prompt, opts = {}) {
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    const args = [
      "--output-format", "stream-json",
      "--dangerously-skip-permissions",
      "--print-timeout", `${Math.max(60, Math.ceil(timeoutMs / 1000))}s`,
    ];
    const cwd = opts.cwd || this.rootDir;
    if (cwd !== this.rootDir) args.push("--add-dir", cwd);
    const session = opts.fresh ? null : this.getSession(opts);
    if (session) args.push("--conversation", session);
    const model = opts.model ?? this.getModel?.();
    // Eski UI kataloğundaki insan-okur etiketleri CLI model kimliği değildir.
    // Yalnız gerçek kimlik biçimindeki özel değerleri geçir; aksi halde hesabın
    // güncel varsayılan modelini kullan.
    if (model && /^[\w.-]+$/.test(String(model)) && !String(model).startsWith("MODEL_")) args.push("--model", model);
    const effort = opts.effort ?? this.getEffort?.();
    if (["low", "medium", "high"].includes(effort)) args.push("--effort", effort);
    if (opts.codeMode) args.push("--mode", "accept-edits");

    const media = opts.media || (opts.images || []).map((file) => ({ path: file }));
    const readable = media.filter((item) => item.path && fs.existsSync(item.path));
    const mediaPrompt = readable.length
      ? `\n\n--- DOĞRUDAN ERİŞİLEBİLEN EKLER ---\n${readable.map((item) =>
          `- ${item.name || path.basename(item.path)} | ${item.mime || "dosya"} | ${item.path}`
        ).join("\n")}\nBu dosyaları kendi yerleşik araçlarınla doğrudan aç ve incele; kullanıcıdan yeniden yüklemesini veya izin vermesini isteme.`
      : "";
    args.push(`-p=${prompt}${mediaPrompt}`);

    let live = "", finalText = "", resultEvent = null;
    const onLine = (line) => {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      const conversationId = ev.conversation_id || ev.init?.conversation_id || ev.result?.conversation_id;
      if (conversationId && !opts.fresh) this.setSession(opts, conversationId);
      if (ev.event === "step_update" && ev.step_update?.text_delta) {
        live += ev.step_update.text_delta;
        this.progress(opts.label || "", live, opts.memberId);
      } else if (ev.event === "result") {
        resultEvent = ev.result;
        finalText = ev.result?.response || finalText;
      }
    };

    const result = await this.spawnCollect(this.bin, args, cwd, timeoutMs, onLine, opts.sessionKey);
    if (result.timedOut) throw new Error("Antigravity çağrısı zaman aşımına uğradı");
    if (result.code !== 0 || resultEvent?.status === "ERROR") {
      throw new Error(`Antigravity hata ile çıktı (exit ${result.code}): ${(result.stderr || result.stdout).slice(0, 600)}`);
    }
    if (!finalText.trim()) throw new Error("Antigravity yanıtı boş döndü");
    this._cliReady = true;
    this.updateBridgeStatus();
    const usage = resultEvent?.usage ? {
      input: resultEvent.usage.input_tokens || 0,
      cachedInput: resultEvent.usage.cache_read_tokens || 0,
      output: resultEvent.usage.output_tokens || 0,
      costUsd: 0,
    } : null;
    if (usage) (opts.onUsage || this.onUsage)?.(usage);
    return { ok: true, text: finalText.trim(), raw: { conversation_id: this.getSession(opts), usage } };
  }

  spawnCollect(bin, args, cwd, timeoutMs, onLine, sessionKey) {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { cwd, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
      child._sessionKey = sessionKey || null;
      this.children.add(child);
      let stdout = "", stderr = "", lineBuf = "", timedOut = false;
      const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGTERM"); } catch {} }, timeoutMs);
      child.stdout.on("data", (d) => {
        stdout += d; lineBuf += d;
        const lines = lineBuf.split("\n"); lineBuf = lines.pop();
        for (const line of lines) if (line.trim()) onLine(line.trim());
      });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("error", (err) => { clearTimeout(timer); this.children.delete(child); reject(err); });
      child.on("close", (code) => {
        clearTimeout(timer); this.children.delete(child);
        if (lineBuf.trim()) onLine(lineBuf.trim());
        this.log(`agy exit=${code} args=${args.slice(0, -1).join(" ")}\nstderr: ${stderr.slice(0, 2000)}`);
        resolve({ stdout, stderr, code, timedOut });
      });
    });
  }
}
