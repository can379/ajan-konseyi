// Is konseye TEKRAR TEKRAR tasinmasin (kullanici karari).
//
// "kordinatör görevleri dağıtır, bir tur oylama yapılır tartışılır ve
// kodlama başlar. kodlamada en ufak birşey yapılamadığında bile sistem
// tekrar konseye taşıyor. bu gereksiz. çözsün ve kodlamayı bitirsin."
//
// Bu dosya dort geri-tasima noktasinin da kapali kaldigini sabitler.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { shouldEscalatePair } from "../src/orchestrator.js";

const oku = (yol) => fs.readFileSync(new URL(`../${yol}`, import.meta.url), "utf8");
const ork = oku("src/orchestrator.js");

test("revizyon YALNIZ gercekten engelleyici bulguda acilir", () => {
  const blok = ork.slice(ork.indexOf("async reconcilePeerFeedback"), ork.indexOf("async _revizyonYap"));
  // Onceden "katilim<=3 VEYA onem yuksek" her gorevi revizyona sokuyordu.
  assert.match(blok, /r\.agreement<=2 && r\.severity==="yuksek"/,
    "düşük katılım VE yüksek önem birlikte aranmalı");
  assert.ok(!/agreement<=3/.test(blok), "eski gevşek eşik kalmamalı");
});

test("revizyon sonrasi YENIDEN inceleme turu yok", () => {
  const blok = ork.slice(ork.indexOf('S.setPhase(run, "review")'), ork.indexOf("ÇELİŞKİ / TARTIŞMA"));
  assert.match(blok, /await this\.reconcilePeerFeedback/);
  assert.ok(!/revalidateChangedReviews/.test(blok),
    "revizyon → yeniden inceleme → yeni revizyon zinciri kapalı olmalı");
});

test("tartisma DONGU degil: tek degerlendirme, sonra oylama", () => {
  const blok = ork.slice(ork.indexOf("ÇELİŞKİ / TARTIŞMA"), ork.indexOf("DOĞRULAYICI TURU"));
  assert.ok(!/while \(round < run\.maxDebateRounds\)/.test(blok),
    "tartışma döngüsü kaldırılmalı — her tur işi konseye geri taşıyordu");
  assert.match(blok, /const assess = await this\.assessConflict\(run, 1, ctx\)/,
    "tek bir çelişki değerlendirmesi olmalı");
  assert.match(blok, /voteInfo = await this\.holdVote\(run, assess\)/,
    "ayrılık varsa doğrudan oylamayla kapanmalı");
});

test("bloke bildiren uye ONCE kendi cozer, konseye tasinmaz", () => {
  assert.match(ork, /const israr = await invokeMember\(/,
    "bloke bildiriminde üyeye ısrar çağrısı gitmeli");
  assert.match(ork, /Bu bir çıkış yolu değil\. Engeli KENDİN çöz/);
  assert.match(ork, /label: "engeli çözüyor"/);
  // Israr da bloke donerse hata sayilir; sonsuz dongu yok.
  assert.match(ork, /else res = \{ ok: false, error: `Ajan işi uygulamadan bloke bildirdi/);
});

test("ikiliden konseye buyutme GEREKCE ister", () => {
  assert.equal(shouldEscalatePair({ buyut: true, issues: ["iki ayrı uzmanlık"] }), true);
  assert.equal(shouldEscalatePair({ buyut: true }), false, "gerekçesiz büyütme yok sayılır");
  assert.equal(shouldEscalatePair({ buyut: true, issues: [] }), false);
  assert.equal(shouldEscalatePair({ buyut: false, issues: ["x"] }), false);
});

test("yetenek sozlesmesi uyeye 'cozumu kendin bul' der", () => {
  assert.match(ork, /ÇÖZÜMÜ KENDİ İÇİNDE ARA/);
  assert.match(ork, /işi geri devretme, "bloke" bildirme veya başka bir üyeye havale etme/);
  // Gercek sinir korunur: geri donduruleme z islemde durmak serbest.
  assert.match(ork, /geri döndürülemez işlem\) dur ve sebebini kanıtıyla yaz/);
});

// ---- INCELEME KALIBRASYONU ----
// Olculdu (7 gorevlik uygulama turu): incelemelerin 7'si de 1/5 + yuksek
// onem verdi ve 7 revizyon turu acildi (11 dakika). Puan bilgi tasimiyordu.
// Kok neden: inceleyiciye dosya/test/tarayici verilmeden "kabul kriterlerini
// dogrula" deniyor; dogrulayamadigi her seye dusuk puan veriyor.
test("inceleyiciye 'dogrulayamadim' ile 'kusur buldum' ayrimi ogretilir", () => {
  const r = oku("src/reviewIsolation.js");
  assert.match(r, /PUANLAMA — DİKKAT/);
  assert.match(r, /Bu senin kısıtın, yazarın kusuru DEĞİL/);
  assert.match(r, /TEK BAŞINA düşük puan ve yüksek önem sebebi SAYMA/);
  assert.match(r, /Her incelemeye 1\/5 \+ yüksek vermek bilgi taşımaz/);
  // Dogrulanamayan konular ayri alanda raporlanir, puani bogmaz.
  assert.match(r, /"dogrulanamayan":\["paketten doğrulanamayan konular"\]/);
});

test("tum gorevler ayni dusuk puani alirsa revizyon acilmaz (olcum arizasi)", async () => {
  const { Orchestrator } = await import("../src/orchestrator.js");
  const o = Object.create(Orchestrator.prototype);
  const kur = (puanlar) => ({
    tasks: puanlar.map((_, i) => ({ id: `t${i + 1}`, status: "done" })),
    reviews: puanlar.map((p, i) => ({ taskId: `t${i + 1}`, agreement: p, severity: "yuksek" })),
  });
  // Hepsi 1/5 -> ayirt etme yok, kalibrasyon bozuk.
  assert.equal(o._kalibrasyonBozuk(kur([1, 1, 1, 1, 1, 1, 1])), true);
  assert.equal(o._kalibrasyonBozuk(kur([1, 2, 2])), true);
  // COGUNLUK olcutu: onceki "HEPSI <=2" surumunde 17 incelemenin icindeki
  // TEK bir 3/5 emniyeti devre disi birakiyordu ve 7 revizyon yine
  // aciliyordu (canli olculdu). Gercek dagilim:
  assert.equal(o._kalibrasyonBozuk(kur([1, 1, 1, 1, 1, 1, 1, 3])), true,
    "tek istisna emniyeti devre dışı bırakmamalı");
  assert.equal(o._kalibrasyonBozuk(kur([1, 2, 2, 1, 3])), true, "4/5 düşükse ayırt etme yok");
  // Gercek ayirt etme varsa revizyon MESRUDUR, engellenmemeli.
  assert.equal(o._kalibrasyonBozuk(kur([1, 4, 5])), false);
  assert.equal(o._kalibrasyonBozuk(kur([2, 2, 4])), false);
  assert.equal(o._kalibrasyonBozuk(kur([2, 2, 4, 5])), false, "yarısı iyiyse kapı çalışsın");
  // Az gorevde tesaduf olabilir; emniyet devreye girmez.
  assert.equal(o._kalibrasyonBozuk(kur([1, 1])), false);
});

test("kalibrasyon bozuksa itirazlar rapora NOT edilir, sessizce atilmaz", () => {
  const ork = oku("src/orchestrator.js");
  assert.match(ork, /bu ölçüm arızası sayıldı, revizyon turu açılmadı/);
  assert.match(ork, /İnceleyici itirazları rapora not edildi/);
});

test("kanit kapisi da kalibrasyona bakar — bilgi tasimayan red birlestirmeyi kilitlemez", () => {
  // Uc tur ust uste is dallarda kaldi, kullaniciya HIC ulasmadi. Puanlama
  // ayirt etmiyorsa kapinin reddi de bilgi tasimaz.
  assert.match(ork, /KAPI DA KALIBRASYONA BAKAR/);
  assert.match(ork, /if \(kapi\.reasons\?\.length && this\._kalibrasyonBozuk\(run\)\)/);
  assert.match(ork, /kanıt kapısı ölçüm arızası sayıldı ve birleştirme yapıldı/);
  assert.match(ork, /İnceleyici itirazları rapora not edildi/);
});
