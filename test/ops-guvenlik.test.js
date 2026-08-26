// Konsey kararinin (run-d8f784ec) guvenlik kapilari.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { KillSwitch, DevreKesici, muhurKontrol, mesajFiltresi, PolitikaKaydi } from "../src/opsGuvenlik.js";
import { opsMetrikleri } from "../src/opsMetrik.js";
import { OpsWorker, FazAyari } from "../src/opsWorker.js";
import { OpsJobs, IS_DURUM } from "../src/opsJobs.js";

const gecici = () => fs.mkdtempSync(path.join(os.tmpdir(), "ajan-guv-"));

test("acil durdurma dosyasi konunca is yurutulmez", async () => {
  const kok = gecici();
  const kill = new KillSwitch(kok);
  assert.equal(kill.aktifMi(), false);
  kill.bas("elle");
  assert.equal(kill.aktifMi(), true);

  const jobs = new OpsJobs();
  const is = jobs.ekle({ isTuru: "ebay_mesaj", hesap: "ANNE", varlikId: "1", risk: 1 }).is;
  const worker = new OpsWorker({ jobs, faz: new FazAyari(4), killSwitch: kill });
  const sonuc = await worker.yurut(is.id);
  assert.equal(sonuc.durduruldu, true);
  assert.equal(jobs.bul(is.id).durum, IS_DURUM.KULLANICI_BEKLIYOR);
});

test("devre kesici: esige gelince o magaza kapanir, digeri acik kalir", () => {
  const k = new DevreKesici({ esik: 3 });
  k.hata("ANNE", "oturum düştü"); k.hata("ANNE", "oturum düştü");
  assert.equal(k.kapaliMi("ANNE"), false);
  k.hata("ANNE", "oturum düştü");
  assert.equal(k.kapaliMi("ANNE"), true);
  assert.equal(k.kapaliMi("WOOY"), false, "bir mağazanın sorunu diğerini kapatmamalı");
  k.basari("ANNE");
  assert.equal(k.kapaliMi("ANNE"), false, "başarı kesiciyi sıfırlamalı");
});

test("devre kesici kapaliyken is yurutulmez", async () => {
  const kesici = new DevreKesici({ esik: 1 });
  kesici.hata("ANNE", "panel açılmadı");
  const jobs = new OpsJobs();
  const is = jobs.ekle({ isTuru: "ebay_mesaj", hesap: "ANNE", varlikId: "1", risk: 1 }).is;
  const worker = new OpsWorker({ jobs, faz: new FazAyari(4), kesici });
  const sonuc = await worker.yurut(is.id);
  assert.equal(sonuc.kesici, true);
});

test("baglam muhru: yanlis pencere, eksik kayit ve yanlis dugme yakalanir", () => {
  const beklenen = { magaza: "ANNE", varlikId: "112-3456789-1234567", dugme: "Confirm your return" };
  assert.equal(muhurKontrol(beklenen, {
    pencereBasligi: "ANNE", metin: "Order 112-3456789-1234567 details", dugme: "Confirm your return",
  }).ok, true);

  const yanlisPencere = muhurKontrol(beklenen, {
    pencereBasligi: "WOOY", metin: "Order 112-3456789-1234567", dugme: "Confirm your return" });
  assert.equal(yanlisPencere.ok, false);
  assert.match(yanlisPencere.mesaj, /WOOY/);

  const kayitYok = muhurKontrol(beklenen, {
    pencereBasligi: "ANNE", metin: "başka bir sipariş", dugme: "Confirm your return" });
  assert.equal(kayitYok.ok, false);

  const yanlisDugme = muhurKontrol(beklenen, {
    pencereBasligi: "ANNE", metin: "112-3456789-1234567", dugme: "Place your order" });
  assert.equal(yanlisDugme.ok, false);
});

test("ekran okunamiyorsa geri alinamaz adim BELIRSIZ olur, tiklama yapilmaz", async () => {
  const jobs = new OpsJobs();
  const is = jobs.ekle({ isTuru: "amazon_iade", hesap: "ANNE", varlikId: "9", risk: 3 }).is;
  // ekranOku verilmedi -> muhur basilamaz
  const worker = new OpsWorker({ jobs, faz: new FazAyari(4), onayIste: async () => true });  // onay var; muhur basilamiyor
  const sonuc = await worker.yurut(is.id);
  assert.equal(sonuc.belirsiz, true);
  assert.match(sonuc.mesaj, /mühr/i);
});

test("mesaj filtresi platform disina yonlendirmeyi ve puan istemeyi engeller", () => {
  assert.equal(mesajFiltresi("Merhaba, kargonuz yarın çıkacak. İyi günler.").ok, true);
  assert.equal(mesajFiltresi("Bize whatsapp'tan yazın").ok, false);
  assert.deepEqual(mesajFiltresi("Numaram 0532 111 22 33").takilan, ["telefon numarası"]);
  assert.equal(mesajFiltresi("destek@firmam.com adresine yazın").ok, false);
  assert.equal(mesajFiltresi("Memnun kaldıysanız 5 yıldız verebilir misiniz?").ok, false);
  assert.equal(mesajFiltresi("Detaylar: https://baskasite.com/x").ok, false);
  assert.equal(mesajFiltresi("Siparişinizi ebay.com üzerinden takip edebilirsiniz.").ok, true,
    "platformun kendi adresi yasak değil");
});

test("mesaj isi filtreye takilirsa gonderilmez, kullaniciya duser", async () => {
  const jobs = new OpsJobs();
  const is = jobs.ekle({ isTuru: "ebay_mesaj", hesap: "ANNE", varlikId: "7", risk: 1,
    veri: { mesajTaslagi: "Bize doğrudan yazın: 0532 111 22 33" } }).is;
  const worker = new OpsWorker({ jobs, faz: new FazAyari(4) });
  const sonuc = await worker.yurut(is.id);
  assert.equal(sonuc.beklemede, true);
  assert.match(sonuc.mesaj, /yasaklı içerik/);
});

test("politika dogrulanmadan faz kapisi acilamaz", () => {
  const kok = gecici();
  const politika = new PolitikaKaydi(kok);
  const faz = new FazAyari(1, { politika });
  assert.throws(() => faz.turAc("amazon_iade"), /politika doğrulaması yok/);

  // Bos onay yetmez: belge, baglanti ve tarih zorunlu.
  assert.equal(politika.dogrula("amazon_iade", { belge: "x" }).ok, false);
  politika.dogrula("amazon_iade", {
    belge: "Amazon Seller Code of Conduct", baglanti: "https://sellercentral.amazon.com/gp/help/G200386250",
    tarih: "2026-01-15" });
  assert.deepEqual(faz.turAc("amazon_iade"), ["amazon_iade"]);

  // Disk kaliciligi: yeni ornek ayni kaydi gormeli.
  assert.equal(new PolitikaKaydi(kok).dogrulandiMi("amazon_iade"), true);
});

test("kuzey yildizi: is denenmediyse sifir degil, YOK", () => {
  assert.equal(opsMetrikleri([]).kuzeyYildizi.deger, null);
  const m = opsMetrikleri([
    { durum: IS_DURUM.TAMAM }, { durum: IS_DURUM.TAMAM },
    { durum: IS_DURUM.BELIRSIZ }, { durum: IS_DURUM.KUYRUKTA },
  ]);
  assert.equal(m.kuzeyYildizi.pay, 2);
  assert.equal(m.kuzeyYildizi.payda, 3, "kuyruktaki iş denenmiş sayılmaz");
});

test("yoklama sagligi paydasi 6'dir (zeynep haric)", () => {
  const m = opsMetrikleri([], { izleyici: { calisiyor: true, sonTur: [{}, {}] } });
  const satir = m.satirlar.find((r) => r.ad === "Yoklanan mağaza");
  assert.equal(satir.deger, "2/6");
  assert.equal(satir.uyari, true);
});

test("sipariş/kargo numarası telefon sanılmaz", () => {
  assert.equal(mesajFiltresi("Sipariş 112-3456789-1234567 kargoya verildi, takip 1Z999AA10123456784").ok, true);
  assert.equal(mesajFiltresi("eBay siparişiniz 12-34567-89012 iade edildi").ok, true);
});
