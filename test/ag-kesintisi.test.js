// Ag kesintisi: internet yokken deneme hakki yakilmaz; "ag bekleniyor"
// durumuna gecilir ve baglanti donunce kaldigi yerden devam edilir.
// Canli vaka: ENOTFOUND hatasi 3 denemeyi yakti, gorev "tamamlayamadi"
// diye dustu — oysa sorun uyede degil, internetteydi.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Orchestrator } from "../src/orchestrator.js";

const orkestra = () => Object.create(Orchestrator.prototype);

test("ag hatalari dogru taninir", () => {
  const o = orkestra();
  for (const hata of [
    "API Error: Can't reach the internet or DNS (ENOTFOUND)",
    "getaddrinfo EAI_AGAIN api.openai.com",
    "fetch failed", "read ECONNRESET", "connect ETIMEDOUT 1.2.3.4:443",
  ]) assert.equal(o.agHatasiMi(hata), true, hata);
  for (const hata of [
    "unknown model", "Claude hata döndürdü: invalid request",
    "zaman aşımına uğradı",   // saglayici ici zaman asimi ag kesintisi degildir
  ]) assert.equal(o.agHatasiMi(hata), false, hata);
});

test("ag beklemesi: kesinti gorulur, baglanti donunce surer, deneme hakki yakilmaz", async () => {
  const o = orkestra();
  // once cevrimdisi, sonra cevrimici
  let cagri = 0;
  o.cevrimiciMi = async () => (++cagri >= 2);
  const mesajlar = [];
  o.store = {
    addMessage: (_r, m) => mesajlar.push(m.content),
    setAgentStatus: () => {}, streamProgress: () => {}, updateRun: (r, ek) => Object.assign(r, ek),
  };
  const run = { stopRequested: false };
  const eskiTimeout = global.setTimeout;
  global.setTimeout = (fn) => eskiTimeout(fn, 1);   // 5 sn bekleme testte 1 ms
  try {
    const sonuc = await o.agBekle(run, {});
    assert.equal(sonuc.offlineGoruldu, true);
    assert.ok(mesajlar.some((m) => /ağ bekleniyor/i.test(m)));
    assert.ok(mesajlar.some((m) => /geri geldi/i.test(m)));
    assert.equal(run.phase, "ag_bekleniyor");
  } finally { global.setTimeout = eskiTimeout; }
});

test("ag zaten VARSA kesinti sayilmaz — normal deneme hakki isler", async () => {
  const o = orkestra();
  o.cevrimiciMi = async () => true;
  o.store = { addMessage: () => { throw new Error("mesaj yazilmamali"); } };
  const sonuc = await o.agBekle({ stopRequested: false }, {});
  assert.equal(sonuc.offlineGoruldu, false);
});

test("durdurulursa bekleme sonsuza kadar donmez", async () => {
  const o = orkestra();
  o.cevrimiciMi = async () => false;
  const run = { stopRequested: false };
  o.store = { addMessage: () => {}, setAgentStatus: () => {}, streamProgress: () => {},
    updateRun: (r, ek) => Object.assign(r, ek) };
  const eskiTimeout = global.setTimeout;
  global.setTimeout = (fn) => { run.stopRequested = true; return eskiTimeout(fn, 1); };
  try {
    const sonuc = await o.agBekle(run, {});
    assert.equal(sonuc.durduruldu, true);
  } finally { global.setTimeout = eskiTimeout; }
});

test("failRun ag hatasinda turu gommez — bekler ve kaldigi yerden surdurur", async () => {
  const o = orkestra();
  const mesajlar = [];
  let pipelineCagri = 0;
  o.store = { addMessage: (_r, m) => mesajlar.push(m.content),
    updateRun: (r, ek) => Object.assign(r, ek || {}) };
  o.agBekle = async () => ({ offlineGoruldu: true });
  o.runPipeline = async () => { pipelineCagri++; };
  o.persistSessions = () => {};
  const run = { stopRequested: false };
  await o.failRun(run, new Error("API Error: Can't reach the API server (ENOTFOUND)"));
  assert.equal(pipelineCagri, 1, "tur kaldığı yerden sürmeli");
  assert.ok(mesajlar.some((m) => /bağlantı bekleniyor/i.test(m)));
  assert.ok(!mesajlar.some((m) => /hatayla sonlandı/.test(m)), "ağ hatası ölüm ilanı değildir");
});

test("failRun ag DISI hatada eski davranisini korur", async () => {
  const o = orkestra();
  const mesajlar = [];
  o.store = { addMessage: (_r, m) => mesajlar.push(m.content),
    updateRun: (r, ek) => Object.assign(r, ek || {}) };
  o.exportArtifacts = () => {}; o.notify = () => {};
  const run = { stopRequested: false, kind: "chat" };
  await o.failRun(run, new Error("Koordinatör geçerli JSON üretemedi"));
  assert.ok(mesajlar.some((m) => /hatayla sonlandı/.test(m)));
});

test("koordinator dayanikli gonderim dongusu kullanir", async () => {
  const fs = await import("node:fs");
  const kaynak = fs.readFileSync(new URL("../src/coordinator.js", import.meta.url), "utf8");
  assert.match(kaynak, /const gonder = async/, "tek deneme yetmez — döngü olmalı");
  assert.match(kaynak, /agDeneme <= 5/, "DNS dalgasında da yinelemeli");
});
