import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { OpsJobs, IS_DURUM, KANIT_SOZLESMESI, kanitDogrula, idempotensAnahtari } from "../src/opsJobs.js";

const oku = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

// ---- CIFT ISLEM KORUMASI ----
// Cift siparis / cift iade = gercek para kaybi. Kuyruga giriste engellenir.

test("ayni is ikinci kez kuyruga GIRMEZ", () => {
  const k = new OpsJobs();
  const ilk = k.ekle({ isTuru: "amazon_siparis", hesap: "ANNE", varlikId: "25-15054-69020" });
  assert.equal(ilk.ok, true);
  const ikinci = k.ekle({ isTuru: "amazon_siparis", hesap: "ANNE", varlikId: "25-15054-69020" });
  assert.equal(ikinci.ok, false);
  assert.equal(ikinci.yinelenen, true);
  assert.equal(ikinci.is.id, ilk.is.id, "ayni ise isaret etmeli");
  // Farkli hesapta ayni numara AYRI istir (magazalar birbirinden bagimsiz).
  assert.equal(k.ekle({ isTuru: "amazon_siparis", hesap: "WOOY", varlikId: "25-15054-69020" }).ok, true);
});

test("idempotens anahtari eksik parcayla uretilmez", () => {
  assert.equal(idempotensAnahtari("amazon_iade", "ANNE", "5327577132"), "amazon_iade:ANNE:5327577132");
  assert.throws(() => idempotensAnahtari("amazon_iade", "ANNE", ""), /şart/);
  assert.throws(() => idempotensAnahtari("amazon_iade", "", "5327577132"), /şart/);
});

// ---- KANIT SOZLESMESI ----
// "Dugmeye bastim" basari degildir.

test("kanit eksikse is TAMAM olmaz, BELIRSIZ'e duser", () => {
  const k = new OpsJobs();
  const { is } = k.ekle({ isTuru: "amazon_siparis", hesap: "ANNE", varlikId: "E-1" });
  k.kirala(is.id, "isci-1");
  const sonuc = k.bitir(is.id, { kanit: { ebayOrderId: "E-1" } });
  assert.equal(sonuc.ok, false);
  assert.equal(sonuc.belirsiz, true);
  assert.equal(k.bul(is.id).durum, IS_DURUM.BELIRSIZ);
  assert.match(sonuc.mesaj, /eksik kanıt: amazonOrderId/);
});

test("tam kanitla is TAMAM olur", () => {
  const k = new OpsJobs();
  const { is } = k.ekle({ isTuru: "amazon_siparis", hesap: "ANNE", varlikId: "E-2" });
  k.kirala(is.id, "isci-1");
  const sonuc = k.bitir(is.id, { kanit: {
    ebayOrderId: "E-2", amazonOrderId: "113-9029894-9385831", asin: "B0D97QSDC4", adet: 1, tutar: 14.98 } });
  assert.equal(sonuc.ok, true);
  assert.equal(k.bul(is.id).durum, IS_DURUM.TAMAM);
  assert.match(sonuc.caprazDogrulama, /sipariş geçmişinde/, "capraz dogrulama hatirlatilmali");
});

test("Amazon siparis numarasi BICIMI dogrulanir", () => {
  const iyi = kanitDogrula("amazon_siparis", {
    ebayOrderId: "E", amazonOrderId: "113-9029894-9385831", asin: "B0", adet: 1, tutar: 5 });
  assert.equal(iyi.ok, true);
  const kotu = kanitDogrula("amazon_siparis", {
    ebayOrderId: "E", amazonOrderId: "12345", asin: "B0", adet: 1, tutar: 5 });
  assert.equal(kotu.ok, false);
  assert.match(kotu.hata, /biçim hatası: amazonOrderId/);
});

test("iade kaniti RMA, yontem, ucretsiz kargo ve etiket ister", () => {
  const s = KANIT_SOZLESMESI.amazon_iade;
  for (const alan of ["rma", "iadeYontemi", "kargoUcretsiz", "etiketKimligi"]) {
    assert.ok(s.zorunlu.includes(alan), `${alan} zorunlu kanit olmali`);
  }
  // Orijinal kart disinda bir yontem kabul edilmemeli (Amazon bakiyesi degil).
  const bakiye = kanitDogrula("amazon_iade", { ebayOrderId: "E", amazonOrderId: "1", rma: "R",
    iadeYontemi: "amazon-bakiye", kargoUcretsiz: true, etiketKimligi: "L" });
  assert.equal(bakiye.ok, false, "bakiye iadesi kanit olarak gecmemeli");
});

// ---- BELIRSIZ != BASARISIZ ----
// Bu ayrim cift siparisin onlendigi yerdir.

test("BELIRSIZ is otomatik yeniden DENENMEZ", () => {
  const k = new OpsJobs();
  const { is } = k.ekle({ isTuru: "amazon_siparis", hesap: "ANNE", varlikId: "E-3" });
  k.kirala(is.id, "isci-1");
  k.hataVer(is.id, { sebep: "Place Order sonucu okunamadı", belirsiz: true });
  assert.equal(k.bul(is.id).durum, IS_DURUM.BELIRSIZ);
  assert.equal(k.uzlastirmaBekleyenler().length, 1, "uzlastirma kuyruguna dusmeli");
  // Siradan hata ise yeniden denenebilir.
  const b = k.ekle({ isTuru: "amazon_siparis", hesap: "ANNE", varlikId: "E-4" });
  k.kirala(b.is.id, "isci-1");
  k.hataVer(b.is.id, { sebep: "sayfa yüklenmedi" });
  assert.equal(k.bul(b.is.id).durum, IS_DURUM.YENIDEN_DENENEBILIR);
  // Uc denemeden sonra kalici.
  k.kirala(b.is.id, "isci-1"); k.hataVer(b.is.id, { sebep: "yine olmadı" });
  k.kirala(b.is.id, "isci-1"); k.hataVer(b.is.id, { sebep: "yine olmadı" });
  assert.equal(k.bul(b.is.id).durum, IS_DURUM.KALICI_HATA, "sonsuz deneme olmamali");
});

// ---- KIRALAMA ----

test("ayni is iki yerde birden calismaz", () => {
  const k = new OpsJobs();
  const { is } = k.ekle({ isTuru: "amazon_iade", hesap: "ANNE", varlikId: "R-1" });
  assert.equal(k.kirala(is.id, "isci-1").ok, true);
  const cakisma = k.kirala(is.id, "isci-2");
  assert.equal(cakisma.ok, false);
  assert.match(cakisma.mesaj, /isci-1 tarafından yürütülüyor/);
  // Kira suresi dolunca serbest kalir (calisan surec olmus olabilir).
  k.bul(is.id).kiraBitis = Date.now() - 1;
  assert.equal(k.kirala(is.id, "isci-2").ok, true);
});

test("kullanici onayi bekleyen is kiralanabilir durumda kalmaz", () => {
  const k = new OpsJobs();
  const { is } = k.ekle({ isTuru: "ebay_dava", hesap: "ANNE", varlikId: "D-1", risk: 4 });
  k.kirala(is.id, "isci-1");
  k.kullaniciBekle(is.id, "dava yanıtı gönderilmeden önce onay şart");
  assert.equal(k.bul(is.id).durum, IS_DURUM.KULLANICI_BEKLIYOR);
  assert.equal(k.bul(is.id).kiralayan, null, "kira birakilmali");
});

// ---- TASARIM KARARI KODA YAZILI ----

test("konseyin iki temel karari kaynakta belgeli", () => {
  const kaynak = oku("src/opsJobs.js");
  assert.match(kaynak, /EYLEM ORGANIDIR, BEYIN DEGIL/, "ekran otomasyonunun rolu yazili olmali");
  assert.match(kaynak, /Dugmeye bastim' basari degildir/, "kanit sozlesmesi yazili olmali");
  assert.match(kaynak, /IKINCI DENEME YAPILMAZ/, "belirsizde tekrar yasagi yazili olmali");
});
