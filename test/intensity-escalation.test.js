import test from "node:test";
import assert from "node:assert/strict";
import { applyIntensity, shouldEscalatePair, INTENSITY_PROFILES } from "../src/orchestrator.js";

// ---- 3) Yogunluk profilleri ----

test("ekonomik yogunluk tartismayi kisar ve dogrulayiciyi kapatir", () => {
  const r = applyIntensity({ intensity: "ekonomik", maxDebateRounds: 4 });
  assert.equal(r.maxDebateRounds, 1, "tartisma 1 tura inmeli");
  assert.equal(r.reviewRounds, 1);
  assert.equal(r.verify, false, "dogrulayici turu atlanmali");
});

test("titiz yogunluk denetimi artirir", () => {
  const r = applyIntensity({ intensity: "titiz", maxDebateRounds: 1 });
  assert.equal(r.maxDebateRounds, 3, "tartisma tabani yukselmeli");
  assert.equal(r.reviewRounds, 2, "gorev basina iki denetci");
  assert.equal(r.verify, true);
});

test("dengeli ve bilinmeyen yogunluk mevcut davranisi korur", () => {
  const dengeli = applyIntensity({ intensity: "dengeli", maxDebateRounds: 2, reviewRounds: 1 });
  assert.deepEqual(dengeli, { maxDebateRounds: 2, reviewRounds: 1, verify: true });
  const bilinmeyen = applyIntensity({ intensity: "sacma", maxDebateRounds: 2 });
  assert.equal(bilinmeyen.maxDebateRounds, 2);
  assert.equal(bilinmeyen.verify, true);
});

test("profil adlari arayuzdeki secenklerle ayni", () => {
  assert.deepEqual(Object.keys(INTENSITY_PROFILES).sort(), ["dengeli", "ekonomik", "titiz"]);
});

// ---- 4) Ikili -> konsey tirmanmasi ----

test("denetci buyut derse tirmanilir, demezse tirmanilmaz", () => {
  // Buyutme artik GEREKCE ister: gerekcesiz "buyut" kolay bir kacis yoluydu
  // ve en ufak eksikte is konseye geri tasiniyordu (kullanici sikayeti).
  assert.equal(shouldEscalatePair({ verdict: "duzeltme", buyut: true, issues: ["iki uzmanlık gerekiyor"] }), true);
  assert.equal(shouldEscalatePair({ verdict: "duzeltme", buyut: true }), false,
    "gerekçesiz büyütme yok sayılır — ikili kendi içinde çözer");
  assert.equal(shouldEscalatePair({ verdict: "duzeltme", buyut: true, issues: [] }), false);
  assert.equal(shouldEscalatePair({ verdict: "onay", buyut: false }), false);
  assert.equal(shouldEscalatePair({ verdict: "duzeltme", issues: ["x"] }), false,
    "duzeltme istemek tirmanma sebebi degildir");
  // Model semaya uymayan deger dondururse tirmanma tetiklenmez (guvenli taraf)
  assert.equal(shouldEscalatePair({ buyut: "evet" }), false);
  assert.equal(shouldEscalatePair(null), false);
});
