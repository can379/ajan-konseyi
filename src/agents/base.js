import fs from "node:fs";
import path from "node:path";
import { now } from "../util.js";

// Sağlayıcı adaptörlerinin ortak temeli (claude / codex / antigravity).
// Konsey ÜYELERİ bu sağlayıcılar üzerinde ayrı oturumlarla yaşar:
// sessionKey = "<runId>#<memberId>" — her üyenin bağlamı ayrıdır.
// Aynı üyeye çağrılar sıraya girer; FARKLI üyeler aynı sağlayıcıda
// paralel çalışır (sağlayıcı başına eşzamanlılık sınırıyla).
const PROVIDER_CONCURRENCY = 4;
const DEFAULT_WATCHDOG_MS = 15 * 60 * 1000;
const WATCHDOG_GRACE_MS = 5 * 1000;

export class BaseAgent {
  constructor(name, store, rootDir) {
    this.name = name;
    this.store = store;
    this.rootDir = rootDir;
    this.sessions = new Map();   // sessionKey -> CLI oturum kimliği
    this.queues = new Map();     // sessionKey -> sıra zinciri
    this.queueEpochs = new Map();// stop sonrası eski sıra zincirini geçersiz kılar
    this.cancelWaiters = new Map();// sessionKey -> çalışan çağrıyı hemen uyandıran iptaller
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
    const epoch = this.queueEpochs.get(key) || 0;
    const prev = this.queues.get(key) || Promise.resolve();
    const job = prev.then(() => {
      if ((this.queueEpochs.get(key) || 0) !== epoch) {
        return { ok: false, text: "", error: "Durduruldu", cancelled: true };
      }
      return this._run(prompt, { ...opts, sessionKey: key });
    });
    const settled = job.then(() => {}, () => {});
    this.queues.set(key, settled);
    settled.finally(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
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
    const key = opts.sessionKey || "global";
    let cancel;
    let timer;
    const cancelled = new Promise((_, reject) => {
      cancel = () => {
        const err = new Error("Durduruldu");
        err.code = "AGENT_CANCELLED";
        reject(err);
      };
      const waiters = this.cancelWaiters.get(key) || new Set();
      waiters.add(cancel);
      this.cancelWaiters.set(key, waiters);
    });
    try {
      const invocation = Promise.resolve().then(() => this.invoke(prompt, opts));
      // Sağlayıcının alt süreci kapanış olayı üretmezse üye kuyruğu sonsuza
      // kadar kilitlenmesin. Adaptör zaman aşımından kısa bir ek pay sonra
      // bağımsız watchdog devreye girer.
      const timeoutMs = Math.max(1, Number(opts.timeoutMs) || DEFAULT_WATCHDOG_MS) + WATCHDOG_GRACE_MS;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`${this.name} çağrısı ${Math.round(timeoutMs / 1000)} saniyede sonuçlanmadı`);
          err.code = "AGENT_WATCHDOG_TIMEOUT";
          reject(err);
        }, timeoutMs);
      });
      const result = await Promise.race([invocation, cancelled, deadline]);
      this._setFree(false);
      return result;
    } catch (err) {
      const msg = String(err.message || err);
      // Kullanıcının durdurması hata değildir; çip kırmızıya düşmesin
      const stopped = err?.code === "AGENT_CANCELLED" || opts.shouldStop?.() === true;
      if (err?.code === "AGENT_WATCHDOG_TIMEOUT") this.stop(key);
      if (!stopped) this._checkQuota(msg);
      this._setFree(!stopped, stopped ? "" : msg);
      return { ok: false, text: "", error: msg, cancelled: stopped };
    } finally {
      clearTimeout(timer);
      const waiters = this.cancelWaiters.get(key);
      waiters?.delete(cancel);
      if (waiters?.size === 0) this.cancelWaiters.delete(key);
      this._release();
    }
  }

  // Alt sınıflar uygular: { ok, text, error? } döndürür.
  async invoke(_prompt, _opts) {
    throw new Error("invoke() alt sınıfta uygulanmalı");
  }

  // key verilirse yalnız o sohbetin/üyenin süreçleri öldürülür
  stop(key) {
    const matches = (sessionKey) => !key || sessionKey === key || sessionKey.startsWith(key + "#");
    const knownKeys = new Set([...this.queues.keys(), ...this.cancelWaiters.keys()]);
    for (const sessionKey of knownKeys) {
      if (!matches(sessionKey)) continue;
      this.queueEpochs.set(sessionKey, (this.queueEpochs.get(sessionKey) || 0) + 1);
      this.queues.delete(sessionKey);
      for (const cancel of this.cancelWaiters.get(sessionKey) || []) cancel();
    }
    for (const child of this.children) {
      if (key && child._sessionKey && !child._sessionKey.startsWith(key)) continue;
      try { child.kill("SIGTERM"); } catch {}
      if (!child._noForceKill) setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2_000);
    }
  }
}
