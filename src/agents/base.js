import fs from "node:fs";
import path from "node:path";
import { now } from "../util.js";

// Sağlayıcı adaptörlerinin ortak temeli (claude / codex / antigravity).
// Konsey ÜYELERİ bu sağlayıcılar üzerinde ayrı oturumlarla yaşar:
// sessionKey = "<runId>#<memberId>" — her üyenin bağlamı ayrıdır.
// Aynı üyeye çağrılar sıraya girer; FARKLI üyeler aynı sağlayıcıda
// paralel çalışır (sağlayıcı başına eşzamanlılık sınırıyla).
const PROVIDER_CONCURRENCY = 4;

export class BaseAgent {
  constructor(name, store, rootDir) {
    this.name = name;
    this.store = store;
    this.rootDir = rootDir;
    this.sessions = new Map();   // sessionKey -> CLI oturum kimliği
    this.queues = new Map();     // sessionKey -> sıra zinciri
    this.children = new Set();   // canlı alt süreçler (sessionKey etiketli)
    this.busyCount = 0;
    this._sem = { active: 0, waiters: [] };
    this.cooldownUntil = 0;      // kota/limit hatasında geçici dinlenme
    this._streamBuf = "";
    this._streamTimer = null;
    this.logFile = path.join(rootDir, "runs", "agent-" + name + ".log");
    store.setAgentStatus(name, "idle");
  }

  log(text) {
    fs.appendFileSync(this.logFile, `[${now()}] ${text}\n`);
  }

  // ---- Oturum yönetimi ----
  getSession(opts) {
    return this.sessions.get(opts?.sessionKey || "global") || null;
  }

  setSession(opts, id) {
    if (id) this.sessions.set(opts?.sessionKey || "global", id);
  }

  clearSession(opts) {
    this.sessions.delete(opts?.sessionKey || "global");
  }

  resetSession(keyPrefix) {
    if (!keyPrefix) { this.sessions.clear(); return; }
    for (const k of [...this.sessions.keys()]) {
      if (k === keyPrefix || k.startsWith(keyPrefix + "#")) this.sessions.delete(k);
    }
  }

  // ---- Kota / durum ----
  _checkQuota(errMsg) {
    if (/rate.?limit|quota|kota|429|too many|limit (reached|exceeded)|usage limit/i.test(errMsg)) {
      this.cooldownUntil = Date.now() + 10 * 60 * 1000;
      const until = new Date(this.cooldownUntil).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
      this.store.setAgentStatus(this.name, "offline", `kota sınırı — ${until}'e kadar dinleniyor`);
      return true;
    }
    return false;
  }

  isAvailable() {
    return Date.now() >= this.cooldownUntil;
  }

  // Canlı akış: kullanıcıyı her tokenla boğmadan seyrek durum güncellemesi.
  progress(label, text, memberId = null) {
    this._streamBuf = { label, text, memberId };
    if (this._streamTimer) return;
    this._streamTimer = setTimeout(() => {
      this._streamTimer = null;
      const b = this._streamBuf;
      this.store.streamProgress(b.memberId || this.name, b.label, b.text);
    }, 1800);
  }

  _setBusy() {
    this.busyCount++;
    const detail = this.busyCount > 1 ? `${this.busyCount} çağrı çalışıyor` : "";
    this.store.setAgentStatus(this.name, "busy", detail);
  }

  _setFree(errored, errMsg) {
    this.busyCount = Math.max(0, this.busyCount - 1);
    if (this.busyCount > 0) {
      this.store.setAgentStatus(this.name, "busy", `${this.busyCount} çağrı çalışıyor`);
    } else if (errored) {
      this.store.setAgentStatus(this.name, "error", errMsg || "");
    } else {
      this.store.setAgentStatus(this.name, "idle");
    }
  }

  // ---- Çağrı: üye başına sıra, sağlayıcı başına sınırlı paralellik ----
  send(prompt, opts = {}) {
    const key = opts.sessionKey || "global";
    const prev = this.queues.get(key) || Promise.resolve();
    const job = prev.then(() => this._run(prompt, opts));
    this.queues.set(key, job.then(() => {}, () => {}));
    return job;
  }

  // Geriye dönük uyumluluk: artık send ile aynı (üyeler doğal paralellik sağlar)
  sendParallel(prompt, opts = {}) {
    return this.send(prompt, opts);
  }

  async _acquire(max) {
    while (this._sem.active >= max) {
      await new Promise((r) => this._sem.waiters.push(r));
    }
    this._sem.active++;
  }

  _release() {
    this._sem.active--;
    const w = this._sem.waiters.shift();
    if (w) w();
  }

  async _run(prompt, opts) {
    await this._acquire(PROVIDER_CONCURRENCY);
    this._setBusy();
    try {
      const result = await this.invoke(prompt, opts);
      this._setFree(false);
      return result;
    } catch (err) {
      const msg = String(err.message || err);
      // Kullanıcının durdurması hata değildir; çip kırmızıya düşmesin
      const stopped = opts.shouldStop?.() === true;
      if (!stopped) this._checkQuota(msg);
      this._setFree(!stopped, stopped ? "" : msg);
      return { ok: false, text: "", error: msg };
    } finally {
      this._release();
    }
  }

  // Alt sınıflar uygular: { ok, text, error? } döndürür.
  async invoke(_prompt, _opts) {
    throw new Error("invoke() alt sınıfta uygulanmalı");
  }

  // key verilirse yalnız o sohbetin/üyenin süreçleri öldürülür
  stop(key) {
    for (const child of this.children) {
      if (key && child._sessionKey && !child._sessionKey.startsWith(key)) continue;
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2_000);
    }
  }
}
