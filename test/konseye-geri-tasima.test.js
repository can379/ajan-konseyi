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
