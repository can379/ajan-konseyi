import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CanSellerAI, READ_ALLOWLIST, temizleKayit } from "../src/cansellerai.js";

const oku = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

// ---- Faz 1 sozlesmesi: YALNIZ OKUMA ----

test("baglayici yalniz izin verilen yollari okur", async () => {
  const c = new CanSellerAI({ fetchImpl: async () => { throw new Error("çağrılmamalıydı"); } });
  c.setServiceKey("test-anahtar");
  await assert.rejects(() => c._get("/api/ui/refund"), /İzin verilmeyen yol/);
  await assert.rejects(() => c._get("/api/ui/returns/1/refund"), /İzin verilmeyen yol/);
  for (const yol of ["/api/ui/returns", "/api/ui/cases", "/api/ui/work-center"]) {
    assert.ok(READ_ALLOWLIST.includes(yol), `${yol} okunabilir olmali`);
  }
});

test("baglayicida yazma yontemi yok (para hareketi bu katmandan gecemez)", () => {
  const kaynak = oku("src/cansellerai.js");
  // Tek istisna hesap SECIMI: veri degistirmez, oturumun baktigi magazayi belirler.
  const postlar = kaynak.match(/method: "(POST|PUT|PATCH|DELETE)"/g) || [];
  assert.equal(postlar.length, 2, "yalniz login ve switch POST olmali: " + postlar.join(","));
  assert.ok(!/refund|iade-onay|place-order|submit/i.test(kaynak), "para/islem ucu gecmemeli");
});

test("oturum sirri disari sizmaz: status cerezi ve anahtari vermez", async () => {
  const c = new CanSellerAI({ fetchImpl: async () => ({ ok: true, status: 200, headers: { getSetCookie: () => ["cansellerai_hub=GIZLI; HttpOnly"] }, json: async () => ({}) }) });
  await c.login("kullanici", "parola");
  const durum = JSON.stringify(c.status());
  assert.ok(!durum.includes("GIZLI"), "cerez durum ciktisinda olmamali");
  assert.ok(!durum.includes("parola"), "parola hicbir yerde tutulmamali");
  assert.equal(c.connected(), true);
  c.setServiceKey("SERVIS-SIRRI");
  assert.ok(!JSON.stringify(c.status()).includes("SERVIS-SIRRI"), "servis anahtari da sizmamali");
});

test("uyeye giden veriden alici kimligi ve adres temizlenir", () => {
  const temiz = temizleKayit({
    return_id: "R-1", buyer: "Ahmet Yılmaz", buyerLogin: "ahmt34",
    address: { street: "X sk 5", zip: "34000" },
    icerik: { email: "a@b.com", urun: "Kablo", adet: 2 },
  });
  assert.equal(temiz.return_id, "R-1", "operasyon alanlari korunmali");
  assert.equal(temiz.icerik.urun, "Kablo");
  assert.equal(temiz.buyer, "[gizlendi]");
  assert.equal(temiz.buyerLogin, "[gizlendi]");
  assert.equal(temiz.address, "[gizlendi]");
  assert.equal(temiz.icerik.email, "[gizlendi]");
});

// ---- Golge modu: uye YORUMLAR, yapmaz ----

test("golge degerlendirme izole cagridir ve risk seviyesi ister", () => {
  const srv = oku("server.js");
  const blok = srv.slice(srv.indexOf('p === "/api/ops/assess"'), srv.indexOf('p === "/api/ops/assess"') + 3000);
  assert.match(blok, /isolated: true/, "arac ve koprular kapali olmali (disariya eylem yapamasin)");
  assert.match(blok, /temizleKayit/, "veri temizlenmeden uyeye gitmemeli");
  assert.match(blok, /GÖLGE MODU/, "uyeye hicbir islem yapilmayacagi soylenmeli");
  assert.match(blok, /Risk seviyesi/, "her kayit icin risk seviyesi istenmeli");
});

test("operasyon uclari yazma icermez", () => {
  const srv = oku("server.js");
  const bas = srv.indexOf("// ---- Operasyon Merkezi (CanSellerAI)");
  const son = srv.indexOf("// ---- Sesli giris");
  const blok = srv.slice(bas, son);
  assert.ok(bas > 0 && son > bas, "operasyon blogu bulunmali");
  for (const yasak of ["/api/ops/refund", "/api/ops/order", "/api/ops/submit", "/api/ops/execute"]) {
    assert.ok(!blok.includes(yasak), `${yasak} Faz 1'de olmamali`);
  }
  assert.match(blok, /p === "\/api\/ops\/overview"/, "okuma ucu olmali");
});

test("arayuz operasyon sekmesi bagli ve parolayi formda birakmaz", () => {
  const html = oku("ui/index.html");
  assert.match(html, /data-tool-tab="ops"/, "sekme olmali");
  assert.match(html, /id="tool-ops"/, "panel olmali");
  assert.match(html, /Parolanız kaydedilmez/, "kullaniciya sinir acikca soylenmeli");
  const app = oku("ui/app.js");
  assert.match(app, /function renderOpsCenter/, "panel cizimi olmali");
  assert.match(app, /e\.target\.reset\(\); \/\/ parola formda da kalmasin/, "parola gonderildikten sonra temizlenmeli");
});

// ---- Bekleme eylemi (uzak masaustu yuklemeleri) ----
test("bilgisayar koprusu sinirli bekleme destekler", async () => {
  const { ComputerBridge, COMPUTER_ACTIONS, describeComputerAction } = await import("../src/computerBridge.js");
  assert.ok(COMPUTER_ACTIONS.includes("wait"), "wait eylemi olmali");
  const kopru = new ComputerBridge("/tmp/ajan-test-bin");
  const basla = Date.now();
  const sonuc = await kopru.request({ action: "wait", payload: { seconds: 0.3 } });
  assert.equal(sonuc.ok, true);
  assert.ok(Date.now() - basla >= 250, "gercekten beklemeli");
  // Sinir: sonsuz bekleyip turu kilitleyemez.
  const uzun = await kopru.request({ action: "wait", payload: { seconds: 999 } });
  assert.ok(uzun.waitedSeconds <= 10, "en fazla 10 saniye beklemeli");
  assert.match(describeComputerAction({ action: "wait", payload: { seconds: 2 } }).title, /saniye beklendi/);
});
