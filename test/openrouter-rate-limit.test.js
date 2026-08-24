import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../src/agents/openRouterAgent.js", import.meta.url), "utf8");
const base = fs.readFileSync(new URL("../src/agents/base.js", import.meta.url), "utf8");

test("429 için ayrı, uzun ve jitter'lı yeniden deneme merdiveni vardır", () => {
  assert.match(src, /RATE_LIMIT_RETRY_DELAYS_MS = \[2_000, 6_000, 15_000, 30_000\]/);
  assert.match(src, /const jitter = \(ms\) =>/);
  // 429'da uzun merdivene geçilir
  assert.match(src, /const ladder = busy \? RATE_LIMIT_RETRY_DELAYS_MS : retryDelays/);
  assert.match(src, /const wait = busy \? jitter\(ladder\[attempt\]\) : ladder\[attempt\]/);
  // Toplam bekleme eski ~9 sn yerine ~53 sn'ye çıkar
  const total = [2000, 6000, 15000, 30000].reduce((a, b) => a + b, 0);
  assert.ok(total > 50_000, "429 merdiveni yeterince uzun değil");
});

test("retry-after üst sınırı 429'da 60 saniyeye çıkar", () => {
  assert.match(src, /function retryAfterMs\(response, fallback, cap = 15_000\)/);
  assert.match(src, /retryAfterMs\(response, wait, busy \? 60_000 : 15_000\)/);
});

test("hesap kotası ile sağlayıcı yoğunluğu ayırt edilir", () => {
  assert.match(src, /function isUpstreamBusy\(status, detail\)/);
  // Gerçek hesap limitleri "yoğunluk" sayılmaz
  assert.match(src, /free-models-per-day\|per-day\|daily limit\|credits\|insufficient\|quota exceeded/);
  // Kullanıcıya hesabıyla ilgili olmadığı söylenir
  assert.match(src, /hesap kotanızla ilgili değildir/);
});

test("geçici sağlayıcı yoğunluğu üyeyi 10 dakika devre dışı bırakmaz", () => {
  assert.match(base, /sağlayıcı şu an yoğun\|provider returned error/);
  // Bu durumda cooldown UYGULANMAZ, üye hazır kalır
  assert.match(base, /setAgentStatus\(this\.name, "idle", "sağlayıcı yoğun/);
  assert.match(base, /return false;\s*\n\s*\}\s*\n\s*if \(\/rate\.\?limit/);
});
