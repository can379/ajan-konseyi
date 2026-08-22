import fs from "node:fs";
import path from "node:path";
import { now } from "../util.js";

// Tüm ajan adaptörlerinin ortak temeli.
// İki çalışma biçimi vardır:
//  - send():        kalıcı ana oturum; çağrılar sıraya girer (inceleme,
//                   tartışma, oylama, doğrudan mesaj bu kanaldan gider).
//  - sendParallel(): görev dağıtımı için "işçi kopyalar"; her kopya TAZE bir
//                   CLI oturumu açar, aynı anda en çok `parallel` kopya çalışır.
export class BaseAgent {
  constructor(name, store, rootDir) {
    this.name = name;
    this.store = store;
    this.rootDir = rootDir;
    this.sessionId = null;       // ana oturum; koşu başına sıfırlanır
    this.queue = Promise.resolve();
    this.children = new Set();   // canlı alt süreçler (durdurma için)
    this.busyCount = 0;
    this._sem = { active: 0, waiters: [] };
    this.cooldownUntil = 0;      // kota/limit hatasında geçici dinlenme
    this._streamBuf = "";
    this._streamTimer = null;
    this.logFile = path.join(rootDir, "runs", "agent-" + name + ".log");
    store.setAgentStatus(name, "idle");
  }

  // Kota/hız limiti hatası mı? Öyleyse ajanı 10 dk soğutmaya al.
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

  // Canlı akış: kısmi çıktıyı en fazla ~600ms'de bir SSE'ye gönder
  progress(label, text) {
    this._streamBuf = text;
    if (this._streamTimer) return;
    this._streamTimer = setTimeout(() => {
      this._streamTimer = null;
      this.store.streamProgress(this.name, label, this._streamBuf);
    }, 600);
  }

  log(text) {
    fs.appendFileSync(this.logFile, `[${now()}] ${text}\n`);
  }

  resetSession() {
    this.sessionId = null;
  }

  _setBusy() {
    this.busyCount++;
    const detail = this.busyCount > 1 ? `${this.busyCount} kopya çalışıyor` : "";
    this.store.setAgentStatus(this.name, "busy", detail);
  }

  _setFree(errored, errMsg) {
    this.busyCount = Math.max(0, this.busyCount - 1);
    if (this.busyCount > 0) {
      this.store.setAgentStatus(this.name, "busy", `${this.busyCount} kopya çalışıyor`);
    } else if (errored) {
      this.store.setAgentStatus(this.name, "error", errMsg || "");
    } else {
      this.store.setAgentStatus(this.name, "idle");
    }
  }

  // Ana oturum: çağrılar sıraya girer, bağlam korunur
  send(prompt, opts = {}) {
    const job = this.queue.then(() => this._run(prompt, opts));
    this.queue = job.then(() => {}, () => {});
    return job;
  }

  // İşçi kopya: taze oturum, semafor ile sınırlı paralellik
  async sendParallel(prompt, opts = {}) {
    const max = Math.max(1, this.getParallel?.() || 1);
    if (max <= 1) return this.send(prompt, opts);
    await this._acquire(max);
    this._setBusy();
    try {
      const result = await this.invoke(prompt, { ...opts, fresh: true });
      this._setFree(false);
      return result;
    } catch (err) {
      const msg = String(err.message || err);
      this._checkQuota(msg);
      this._setFree(true, msg);
      return { ok: false, text: "", error: msg };
    } finally {
      this._release();
    }
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
    this._setBusy();
    try {
      const result = await this.invoke(prompt, opts);
      this._setFree(false);
      return result;
    } catch (err) {
      const msg = String(err.message || err);
      this._checkQuota(msg);
      this._setFree(true, msg);
      return { ok: false, text: "", error: msg };
    }
  }

  // Alt sınıflar uygular: { ok, text, error? } döndürür.
  // opts.fresh doğruysa ana oturuma DOKUNMADAN taze oturum kullanmalıdır.
  async invoke(_prompt, _opts) {
    throw new Error("invoke() alt sınıfta uygulanmalı");
  }

  stop() {
    for (const child of this.children) {
      try { child.kill("SIGTERM"); } catch {}
    }
    this.children.clear();
  }
}
