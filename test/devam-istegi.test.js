// "devam et" TEK BASINA BIR GOREV DEGILDIR — son gercek istegin devamidir.
//
// Canli vaka: kullanici uygulamada "devam et kaldigin yerden" yazdi.
// Koordinator bunu yeni bir istek sandi, ondan ONCEKI (cok daha eski) macOS
// cokme isine dondu ve o anki ozellik listesini cope atti. Kullanici:
// "devam et demek devam et demektir, bunu anlamasini saglayacak bir
// guncelleme yayinla."
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { isDevamIstegi, sonGercekIstek, Orchestrator } from "../src/orchestrator.js";

test("devam ifadeleri taninir", () => {
  for (const t of ["devam et", "devam", "Devam Et.", "devam et kaldığın yerden",
                   "kaldığın yerden devam et", "sürdür", "continue", "go on"]) {
    assert.equal(isDevamIstegi(t), true, t);
  }
});

test("icinde yeni talimat olan mesaj devam ifadesi SAYILMAZ", () => {
  // "devam et ama once sunu yap" yeni bir talimattir; asil istegi ezmemeli.
  for (const t of ["devam et ama önce testleri çalıştır",
                   "yeni bir özellik ekle",
                   "devam et ve APK'yı da güncelle, sonra paketleri sil"]) {
    assert.equal(isDevamIstegi(t), false, t);
  }
});

test("son gercek istek devam ifadelerini atlayarak bulunur", () => {
  const messages = [
    { from: "kullanici", content: "macOS çökmesini düzelt" },
    { from: "m-claude", content: "tamam" },
    { from: "kullanici", content: "sohbet arayüzünü WhatsApp gibi yap, GIF ekle" },
    { from: "m-codex", content: "başladım" },
    { from: "kullanici", content: "devam et" },
    { from: "kullanici", content: "devam et kaldığın yerden" },
  ];
  // Iki devam ifadesi de atlanip ASIL istek bulunmali — eski cokme isi degil.
  assert.match(sonGercekIstek(messages), /WhatsApp gibi yap/);
  assert.ok(!/çökmesini düzelt/.test(sonGercekIstek(messages)));
});

test("hic gercek istek yoksa bos doner", () => {
  assert.equal(sonGercekIstek([{ from: "kullanici", content: "devam et" }]), "");
  assert.equal(sonGercekIstek([]), "");
});

test("devam istegi koordinatore ASIL istek + gorev durumu olarak gider", async () => {
  const o = Object.create(Orchestrator.prototype);
  const run = {
    id: "r1", turnActive: false, mode: "auto", messages: [
      { from: "kullanici", content: "sohbet arayüzünü WhatsApp gibi yap" },
    ],
    tasks: [
      { id: "t1", title: "Arayüz incelemesi", status: "done" },
      { id: "t2", title: "GIF gönderme", status: "active" },
      { id: "t3", title: "Sticker arama", status: "pending" },
    ],
  };
  // continueChat'in yalniz istek kurma kismini yalitarak sinariz.
  o.store = { updateRun() {}, addMessage() {}, emit() {} };
  let kurulan = null;
  o.coordCtx = () => ({});
  o.restoreSessions = () => {};
  // Gercek continueChat cok is yapar; burada istek kurma mantigini
  // kaynaktan dogrularız.
  const kaynak = fs.readFileSync(new URL("../src/orchestrator.js", import.meta.url), "utf8");
  const blok = kaynak.slice(kaynak.indexOf("if (isDevamIstegi(text))"),
                            kaynak.indexOf("attachments = await enrichAttachments"));
  assert.match(blok, /DEVAM EDİLECEK ASIL İSTEK/, "asıl istek koordinatöre verilmeli");
  assert.match(blok, /TAMAMLANAN görevler \(TEKRAR ETME\)/, "biten görevler tekrarlanmamalı");
  assert.match(blok, /YARIM KALAN görevler \(BUNLARI BİTİR\)/, "yarım kalanlar bitirilmeli");
  assert.match(blok, /daha eski konulara DÖNME/, "eski işe dönüş açıkça yasaklanmalı");
  void o; void run; void kurulan;
});

test("kullanicinin yazdigi metin sohbette AYNEN gorunur", () => {
  // Genisletilmis metin yalniz koordinatore gider; sohbette "devam et" yazar.
  const kaynak = fs.readFileSync(new URL("../src/orchestrator.js", import.meta.url), "utf8");
  assert.match(kaynak,
    /S\.addMessage\(run, \{ from: "kullanici", kind: "message", content: text \|\| "Ek dosyaları incele\."/,
    "sohbete ham kullanıcı metni yazılmalı, genişletilmiş istek değil");
});
