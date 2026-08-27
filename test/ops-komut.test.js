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

test("komut yorumu kosusu kendiliginden yeniden baslatilmaz", async () => {
  const fs = await import("node:fs");
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  // Yorum kosusu gecicidir. Uygulama o sirada kapanirsa 'kaldigi yerden
  // devam' onu normal konsey kosusu sanip koordinatoru calistiriyor ve
  // bos yere uye tuketiyordu (canli goruldu, durduruldu).
  const blok = server.slice(server.indexOf("Komut yorumu:"), server.indexOf("Komut yorumu:") + 700);
  assert.match(blok, /run\.autoResume = false/, "yorum koşusu autoResume kapalı olmalı");
});

// ---- Amac ayrimi: "kontrol et" gozlemdir, faz kapisina takilmaz ----
test("gozlem amacli komut islem sanilmaz", async () => {
  const { amacCoz, komutCoz } = await import("../src/opsKomut.js");
  // Canli vaka: bu komut risk-3 islem sanilip kapali kuyruga atildi.
  assert.equal(amacCoz("ANNE mağazasına gir iadeleri kontrol et"), "gozlem");
  assert.equal(amacCoz("anneye bak iade var mı"), "gozlem");
  assert.equal(amacCoz("iadeleri listele"), "gozlem");
  // Islem fiili varsa ISLEM kazanir — "bak ve al" gozlem degildir.
  assert.equal(amacCoz("ANNE iadelerini al"), "islem");
  assert.equal(amacCoz("iadeleri incele ve al"), "islem");
  // Belirsizde guvenli taraf: kuyruk.
  assert.equal(amacCoz("ANNE iadeler"), "islem");

  const cozum = komutCoz("ANNE mağazasına gir iadeleri kontrol et",
    { uyeler: [], cihazlar: [{ name: "ANNE" }] });
  assert.equal(cozum.ok, true);
  assert.equal(cozum.amac, "gozlem");
});

test("sunucu gozlem komutunu kuyruga atmadan hemen calistirir", async () => {
  const fs = await import("node:fs");
  const kaynak = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const blok = kaynak.slice(kaynak.indexOf('cozum.amac === "gozlem"') - 200,
    kaynak.indexOf('cozum.amac === "gozlem"') + 600);
  assert.match(blok, /opsRun\.gozlemle/, "gözlem doğrudan tur başlatmalı");
  assert.ok(!/opsJobs\.ekle/.test(blok), "gözlem iş kuyruğuna girmemeli");
});

test("koordinator ag kesintisinde beklemeye gecer", async () => {
  const fs = await import("node:fs");
  const koordinator = fs.readFileSync(new URL("../src/coordinator.js", import.meta.url), "utf8");
  assert.match(koordinator, /agKanca\?\.hataMi/, "koordinatör ağ hatasını tanımalı");
  const ork = fs.readFileSync(new URL("../src/orchestrator.js", import.meta.url), "utf8");
  assert.match(ork, /this\.coordinator\.agKanca = \{/, "kanca orkestradan bağlanmalı");
});
