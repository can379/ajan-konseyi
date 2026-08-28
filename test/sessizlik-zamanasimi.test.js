// TUR SURESI: takilmis cagri 15 dakika bos beklenmemeli.
//
// Olculdu (run-33935cd3, 46 dakikalik tur): iki basarisiz Claude cagrisi
// 549sn + 900sn = 24 dakika goturdu — turun yarisindan fazlasi. Sistem
// "takilmis" ile "calisiyor" arasini ayirt edemiyor, sabit toplam siniri
// bekliyordu.
//
// Cozum: CALISAN cagri surekli cikti yayar. Belirli sure hic satir gelmezse
// cagri olmustur; erken kesilir. Uzun ama calisan isler etkilenmez cunku
// her satir sayaci sifirlar.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const oku = (yol) => fs.readFileSync(new URL(`../${yol}`, import.meta.url), "utf8");

for (const [ad, dosya] of [
  ["Claude", "src/agents/claudeAgent.js"],
  ["Codex", "src/agents/codexAgent.js"],
  ["Antigravity", "src/agents/antigravityAgent.js"],
]) {
  test(`${ad}: sessizlik zaman asimi var ve cikti sayaci sifirlar`, () => {
    const k = oku(dosya);
    assert.match(k, /const SESSIZLIK_MS = \d+ \* 60 \* 1000/, "sessizlik eşiği tanımlı olmalı");
    assert.match(k, /sessizlikTimer = setTimeout\(\(\) => oldur\("yanıt akmıyor \(sessizlik\)"\)/,
      "sessizlikte çağrı öldürülmeli");
    assert.match(k, /const canlilik = \(\) => \{/, "canlılık sayacı olmalı");
    // Cikti geldiginde sayac SIFIRLANMALI — yoksa uzun ama calisan is kesilir.
    assert.match(k, /child\.stdout\.on\("data", \(d\) => \{\s*\n?\s*canlilik\(\);/,
      "stdout her veride sayacı sıfırlamalı");
    assert.match(k, /child\.stderr\.on\("data", \(d\) => \{ canlilik\(\);/,
      "stderr de canlılık sayılmalı");
    // Sizinti olmasin: kapanista ve hatada temizlenmeli.
    assert.match(k, /clearTimeout\(sessizlikTimer\)/, "kapanışta temizlenmeli");
    // Sessizlik esigi toplam siniri ASMAMALI (kisa timeoutMs verilen cagrilar).
    assert.match(k, /Math\.min\(SESSIZLIK_MS, timeoutMs\)/,
      "kısa süreli çağrılarda sessizlik eşiği toplam sınırı aşmamalı");
  });
}

test("Antigravity esigi digerlerinden yuksek — arac turlari arasi sessizlik normal", () => {
  const ag = oku("src/agents/antigravityAgent.js").match(/const SESSIZLIK_MS = (\d+) \* 60/)[1];
  const cl = oku("src/agents/claudeAgent.js").match(/const SESSIZLIK_MS = (\d+) \* 60/)[1];
  assert.ok(Number(ag) > Number(cl), "agy araç turları arasında daha uzun sessiz kalabiliyor");
});

test("takilma UC KEZ tekrarlanmaz — tek yeniden deneme", () => {
  const ork = oku("src/orchestrator.js");
  assert.match(ork, /const takilma = \/zaman aşım\|yanıt akmıyor\/i\.test/,
    "takılma normal hatadan ayrılmalı");
  assert.match(ork, /const ustSinir = takilma \? 2 : 3/,
    "takılmada tek yeniden deneme, normal hatada üç");
  assert.match(ork, /yanıt vermedi \(takıldı\); temiz oturumla son kez deneniyor/,
    "kullanıcı ne olduğunu görmeli");
});
