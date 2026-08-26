import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { OpsWatcher, kayitlariCikar } from "../src/opsWatcher.js";
import { OpsJobs } from "../src/opsJobs.js";

const oku = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

const SAHTE_PANEL = {
  connected: () => true,
  overview: async () => ({
    returns: { items: [{ return_id: "5327577132", acik: true, urunAdi: "Pizza Sauce",
      sebepAdi: "Ürün ulaşmadı", kalanGun: 1, order_id: "09-15047-77014" }] },
    cases: { items: [{ case_id: "CASE-9", status: "OPEN", type: "inquiry", item_title: "Kablo" }] },
    work: { groups: [{ key: "orders", items: [{ ebay_order_id: "25-15054-69020", title: "Kablo",
      detail: "Hazırlanmayı bekliyor" }] }] },
  }),
};

test("panel kayitlari tek bicime cevrilir", () => {
  const iadeler = kayitlariCikar("returns", { items: [{ return_id: "R1", urunAdi: "Ürün", kalanGun: 1 }] });
  assert.equal(iadeler[0].isTuru, "amazon_iade");
  assert.equal(iadeler[0].varlikId, "R1");
  assert.equal(iadeler[0].onem, "yuksek", "2 gun ve alti acil olmali");
  const gec = kayitlariCikar("returns", { items: [{ return_id: "R2", kalanGun: 9 }] });
  assert.equal(gec[0].onem, "orta");
  // Kimliksiz kayit atilir (idempotens anahtari uretilemez).
  assert.equal(kayitlariCikar("returns", { items: [{ urunAdi: "kimliksiz" }] }).length, 0);
});

test("canli kayitlar ISE donusur, ayni kayit TEKRAR donusmez", async () => {
  const jobs = new OpsJobs();
  const w = new OpsWatcher({ canseller: SAHTE_PANEL, jobs, store: null });
  w.hesap = "ANNE";
  const ilk = await w.yokla();
  assert.equal(ilk.yeni, 3, "uc kayit da ise donmeli");
  const ikinci = await w.yokla();
  assert.equal(ikinci.yeni, 0, "ayni kayitlar ikinci kez ise donmemeli");
  const turler = jobs.liste().map((i) => i.isTuru).sort();
  assert.deepEqual(turler, ["amazon_iade", "amazon_siparis", "ebay_dava"]);
  // Dava riski en yuksek olmali (her seferinde onay).
  assert.equal(jobs.liste().find((i) => i.isTuru === "ebay_dava").risk, 4);
});

test("OLGUNLASMA penceresi: yeni kayit hemen yurutulmez", async () => {
  const jobs = new OpsJobs();
  const w = new OpsWatcher({ canseller: SAHTE_PANEL, jobs, store: null, ayar: { olgunlasmaMs: 50 } });
  w.hesap = "ANNE";
  await w.yokla();
  assert.equal(w.olgunMu("amazon_iade", "5327577132"), false, "yeni kayit beklemeli");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(w.olgunMu("amazon_iade", "5327577132"), true, "sure dolunca olgun olmali");
  // Izleyicinin gormedigi (elle acilmis) is beklemez.
  assert.equal(w.olgunMu("amazon_iade", "BASKA"), true);
});

test("kapanan kayit izlemeden dusurulur (bellek sismesin)", async () => {
  const jobs = new OpsJobs();
  let acik = true;
  const panel = { connected: () => true, overview: async () => ({
    returns: { items: [{ return_id: "R9", acik, urunAdi: "X" }] }, cases: null, work: null }) };
  const w = new OpsWatcher({ canseller: panel, jobs, store: null });
  w.hesap = "ANNE";
  await w.yokla();
  assert.equal(w.gorulen.size, 1);
  acik = false;                    // iade kapandi
  await w.yokla();
  assert.equal(w.gorulen.size, 0, "kapanan kayit izlemede kalmamali");
});

test("oturum dusunce izleyici sessizce calismaya devam etmez", async () => {
  const jobs = new OpsJobs();
  const w = new OpsWatcher({ canseller: { connected: () => false }, jobs, store: null });
  const sonuc = await w.yokla();
  assert.equal(sonuc.ok, false);
  assert.match(w.durum().sonHata, /oturumu düştü/);
  assert.equal(w.baslat("ANNE").ok, false, "baglanti yokken baslamamali");
});

test("olgunlasma gerekcesi kaynakta belgeli", () => {
  const kaynak = oku("src/opsWatcher.js");
  assert.match(kaynak, /CanSellerAI SENSOR, uzak masaustu EL/, "rol dagilimi yazili olmali");
  assert.match(kaynak, /yarim veriyle islem baslatmak/i, "erken mudahale riski yazili olmali");
  assert.match(kaynak, /gorur gormez KUYRUGA alinir/i, "kayit kacirilmamali");
});
