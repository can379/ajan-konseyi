import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { OpsJobs, IS_DURUM } from "../src/opsJobs.js";
import { OpsWorker, FazAyari } from "../src/opsWorker.js";
import { RISK, FAZ1_UST_SINIR } from "../src/opsPlaybook.js";

const oku = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

// ---- FAZ KAPISI ----
// Kullanici acmadikca para etkileyen is YURUTULMEZ.

test("varsayilan faz 1: risk 3 is yurutulmez", async () => {
  const jobs = new OpsJobs();
  const { is } = jobs.ekle({ isTuru: "amazon_siparis", hesap: "ANNE", varlikId: "E-1", risk: RISK.ONAY });
  const w = new OpsWorker({ jobs, controller: {}, orchestrator: {}, store: {}, config: {} });
  assert.equal(w.faz.ustSinir, FAZ1_UST_SINIR, "varsayilan faz 1 olmali");
  const sonuc = await w.yurut(is.id);
  assert.equal(sonuc.ok, false);
  assert.equal(sonuc.kapali, true, "kapi kapali olmali");
  assert.equal(jobs.bul(is.id).durum, IS_DURUM.KULLANICI_BEKLIYOR);
  assert.match(jobs.bul(is.id).gecmis.at(-1).not, /faz sınırının \(1\) üstünde/);
});

test("faz kapisi tek yerden acilir ve gecersiz seviye kabul etmez", () => {
  const f = new FazAyari();
  assert.equal(f.izinliMi(RISK.ONAY), false);
  f.ac(RISK.ONAY);
  assert.equal(f.izinliMi(RISK.ONAY), true);
  assert.equal(f.izinliMi(RISK.HER_SEFERINDE), false, "ust seviye hala kapali");
  assert.throws(() => f.ac(9), /Geçersiz risk seviyesi/);
  assert.throws(() => f.ac(-1), /Geçersiz risk seviyesi/);
  assert.match(f.durum().aciklama, /Faz 3/);
});

// ---- ONAY KAPISI ----

test("geri alinamaz adimda onay YOKSA hicbir sey yapilmaz", async () => {
  const jobs = new OpsJobs();
  const faz = new FazAyari(RISK.ONAY);
  const { is } = jobs.ekle({ isTuru: "amazon_siparis", hesap: "ANNE", varlikId: "E-2", risk: RISK.ONAY });
  // onayIste verilmedi -> guvenli varsayilan: onaysiz.
  const w = new OpsWorker({ jobs, controller: {}, orchestrator: {}, store: {}, config: {}, faz });
  const sonuc = await w.yurut(is.id);
  assert.equal(sonuc.ok, false);
  assert.equal(sonuc.beklemede, true);
  assert.equal(jobs.bul(is.id).durum, IS_DURUM.KULLANICI_BEKLIYOR,
    "onaysiz is BEKLEMEDE kalmali, yeniden denenmemeli");
  assert.match(jobs.bul(is.id).gecmis.at(-1).not, /Place your order/);
});

test("onay isteyen fonksiyon hata verirse ONAYSIZ sayilir", async () => {
  const jobs = new OpsJobs();
  const { is } = jobs.ekle({ isTuru: "amazon_iade", hesap: "ANNE", varlikId: "R-1", risk: RISK.ONAY });
  const w = new OpsWorker({ jobs, controller: {}, orchestrator: {}, store: {}, config: {},
    faz: new FazAyari(RISK.ONAY), onayIste: async () => { throw new Error("onay kanalı yok"); } });
  await w.yurut(is.id);
  assert.equal(jobs.bul(is.id).durum, IS_DURUM.KULLANICI_BEKLIYOR, "hata durumunda onay verilmis sayilmamali");
});

// ---- KANITSIZ BASARI YASAGI ----

test("onay verilse bile KANIT yoksa is TAMAM olmaz", async () => {
  const jobs = new OpsJobs();
  const { is } = jobs.ekle({ isTuru: "amazon_siparis", hesap: "ANNE", varlikId: "E-3", risk: RISK.ONAY });
  const w = new OpsWorker({ jobs, controller: {}, orchestrator: {}, store: {}, config: {},
    faz: new FazAyari(RISK.ONAY), onayIste: async () => true });
  const sonuc = await w.yurut(is.id);
  assert.equal(sonuc.belirsiz, true);
  assert.equal(jobs.bul(is.id).durum, IS_DURUM.BELIRSIZ, "kanitsiz is belirsiz olmali");
  assert.equal(jobs.uzlastirmaBekleyenler().length, 1);
});

test("on kosul eksikse is yurutulmez", async () => {
  const jobs = new OpsJobs();
  const { is } = jobs.ekle({ isTuru: "amazon_siparis", hesap: "ANNE", varlikId: "E-4", risk: RISK.ONAY,
    veri: { onKosulEksik: ["müşteri adresi", "ASIN"] } });
  const w = new OpsWorker({ jobs, controller: {}, orchestrator: {}, store: {}, config: {},
    faz: new FazAyari(RISK.ONAY), onayIste: async () => true });
  await w.yurut(is.id);
  assert.equal(jobs.bul(is.id).durum, IS_DURUM.KULLANICI_BEKLIYOR);
  assert.match(jobs.bul(is.id).gecmis.at(-1).not, /müşteri adresi, ASIN/);
});

// ---- SIRA SECIMI ----

test("kuyruktan yalniz faz sinirina uyan is secilir", () => {
  const jobs = new OpsJobs();
  jobs.ekle({ isTuru: "amazon_siparis", hesap: "ANNE", varlikId: "E-5", risk: RISK.ONAY });
  jobs.ekle({ isTuru: "ebay_mesaj", hesap: "ANNE", varlikId: "M-1", risk: RISK.TASLAK });
  const w = new OpsWorker({ jobs, controller: {}, orchestrator: {}, store: {}, config: {} });
  assert.equal(w.siradakiIs().varlikId, "M-1", "faz 1'de yalniz taslak isi alinmali");
  w.faz.ac(RISK.ONAY);
  assert.ok(["E-5", "M-1"].includes(w.siradakiIs().varlikId), "kapi acilinca siparis de secilebilir");
});

test("cerceve ve kapilar kaynakta belgeli", () => {
  const kaynak = oku("src/opsWorker.js");
  assert.match(kaynak, /FAZ KAPISI BURADA/, "kapi tek yerde olmali");
  assert.match(kaynak, /ONAYSIZ SAYILIR \(guvenli varsayilan\)/);
  assert.match(kaynak, /kanitsiz "tamam" demek yasak/);
});
