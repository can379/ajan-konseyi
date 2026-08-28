// Kimlik modu inceleme/tartisma/oylama cagrilarina SIZMAMALI.
//
// Canli vaka: [t2] incelemesi "Ben Antigravity'yim. Ajan Konseyi'nde Google
// Antigravity saglayicisi uzerinden calisan yapay zeka uyesiyim; Codex
// degilim." diye geldi — inceleme hic yapilmadi. Sebep: gorev metninde gecen
// siradan bir "kim yapti" / "hangi model" ifadesi cagriyi kimlik sorusu
// saniyordu.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { isIdentityQuestion } from "../src/orchestrator.js";

const ork = fs.readFileSync(new URL("../src/orchestrator.js", import.meta.url), "utf8");

test("gercek kimlik sorulari taninir", () => {
  for (const t of ["sen kimsin?", "Kimsin", "kimsin", "kendini tanıt",
                   "Sen hangi modelsin?", "hangi yapay zekâsın",
                   // Kullanici sik sik "@Uye:" diye hitap ediyor; onek atilmali.
                   "@Claude: sen kimsin", "@Antigravity: sen kimsin?",
                   // Ikinci sahis fiil = kimlik sorusu.
                   "hangi model kullanıyorsun"]) {
    assert.equal(isIdentityQuestion(t), true, t);
  }
});

test("gorev metnindeki siradan ifadeler kimlik sorusu SAYILMAZ", () => {
  const yanlisTetikleyenler = [
    "Hangi model kullanıldığını doğrula",
    "Değişikliği kim yaptı belirsiz",
    "hangi sağlayıcı seçildi kayda geç",
    "Kim hangi dosyayı değiştirdi listele",
  ];
  for (const t of yanlisTetikleyenler) {
    assert.equal(isIdentityQuestion(t), false, `yanlış tetikledi: ${t}`);
  }
});

test("uzun gorev/inceleme istemi kimlik sorusu degildir", () => {
  const uzun = "t1'in belirlediği entegrasyon tabanından devam et; önceki koşuda "
    + "tamamlanmış işleri tekrarlama. package.json, lock dosyası, Electron builder "
    + "yapılandırmasını oku. Bir dosya hakkında iddia üretmeden önce güncel halini "
    + "oku ve kim hangi değişikliği yaptı kayda geç. Sen hangi modelsin sorusu da geçse "
    + "bu bir görev istemidir, kimlik sorusu değildir.";
  assert.ok(uzun.length > 200);
  assert.equal(isIdentityQuestion(uzun), false, "200 karakterden uzun metin görev istemidir");
});

test("ic cagrilar kimlik modunu kapatir", () => {
  // Inceleme, ikili inceleme, istisare ve oylama cagrilarinin hepsi
  // noIdentityMode ile isaretli olmali.
  assert.match(ork, /const identityQuestion = !opts\.noIdentityMode && isIdentityQuestion\(routeText\)/);
  assert.equal((ork.match(/noIdentityMode:true/g) || []).length, 4,
    "inceleme + ikili inceleme + istişare + oylama = 4 iç çağrı korunmalı");
  for (const etiket of ["inceleme: \\$\\{task\\.id\\}", '"ikili inceleme"', "istişare: \\$\\{task\\.id\\}", '"oylama"']) {
    const i = ork.search(new RegExp(etiket));
    assert.ok(i > -1, `${etiket} bulunamadı`);
    assert.match(ork.slice(i, i + 260), /noIdentityMode:true/, `${etiket} korunmamış`);
  }
});
