// Serbest metin komutlari: Turkce ekler ve uye yorumunun sinirlari.
import { test } from "node:test";
import assert from "node:assert/strict";

// ---- Turkce ekler: kullanici kesme isareti koymuyor ----
test("magaza adi yapisik ekle de taninir (wooya gir, anneye bak)", async () => {
  const { magazaCoz, komutCoz } = await import("../src/opsKomut.js");
  const cihazlar = ["ANNE", "CanSelim", "LUTUF", "rahime", "Sihhat", "WOOY", "yeni amerika"]
    .map((name) => ({ name }));

  // Kullanicinin sikayet ettigi komut: "wooya gir dediğim çok belli."
  assert.deepEqual(magazaCoz("wooya gir en son gelen mesajı kontrol et", cihazlar),
    { ok: true, magaza: "WOOY" });
  assert.deepEqual(magazaCoz("anneye bak", cihazlar), { ok: true, magaza: "ANNE" });
  assert.deepEqual(magazaCoz("lutufa gir", cihazlar), { ok: true, magaza: "LUTUF" });
  assert.deepEqual(magazaCoz("rahimenin iadeleri", cihazlar), { ok: true, magaza: "rahime" });
  assert.deepEqual(magazaCoz("yeni amerikaya gir", cihazlar), { ok: true, magaza: "yeni amerika" });

  // Ek TANIMAK, alakasiz kelimeye uymak demek degil.
  assert.equal(magazaCoz("başka bir şey yap", cihazlar).ok, false);

  const tam = komutCoz("wooya gir en son gelen mesajı kontrol et", { uyeler: [], cihazlar });
  assert.equal(tam.ok, true);
  assert.equal(tam.magaza, "WOOY");
  assert.equal(tam.isTuru, "ebay_mesaj");
});

// ---- Uye yorumu: serbest degil, listeden secer ----
test("uye yorumu liste disina cikamaz ve dusuk guvende reddedilir", async () => {
  const { yorumDogrula, yorumIstemi } = await import("../src/opsKomut.js");
  const cihazlar = [{ name: "WOOY" }, { name: "ANNE" }];
  const isTurleri = { ebay_mesaj: "Alıcı mesajı", amazon_iade: "İade" };

  // Uydurulmus magaza: en pahali hata sinifi. Kabul edilmez.
  assert.equal(yorumDogrula({ magaza: "ZEYNEP", isTuru: "ebay_mesaj", guven: "yuksek" },
    { cihazlar, isTurleri }).ok, false);
  assert.equal(yorumDogrula({ magaza: "WOOY", isTuru: "uydurma_is", guven: "yuksek" },
    { cihazlar, isTurleri }).ok, false);
  // Emin degilse yurutulmez.
  assert.equal(yorumDogrula({ magaza: "WOOY", isTuru: "ebay_mesaj", guven: "dusuk" },
    { cihazlar, isTurleri }).ok, false);
  assert.equal(yorumDogrula({ magaza: "WOOY", isTuru: "ebay_mesaj", guven: "yuksek", neden: "wooya = WOOY" },
    { cihazlar, isTurleri }).ok, true);
  assert.equal(yorumDogrula(null, { cihazlar, isTurleri }).ok, false);

  // Istem yalniz kayitli adlari sunar; model baska ad goremez.
  const istem = yorumIstemi("wooya gir", { cihazlar, isTurleri });
  assert.match(istem, /WOOY/);
  assert.ok(!/ZEYNEP/.test(istem));
});
