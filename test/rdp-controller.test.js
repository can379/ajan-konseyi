import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { RdpController, hedefSec, adEslesir, yeniDurum, GOZLEM_EYLEMLERI } from "../src/rdpController.js";

const oku = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

// Canli Windows App'ten okunan gercek liste (AX agaci).
const CIHAZLAR = [
  { name: "ANNE", x: 548, y: 172 }, { name: "CanSelim", x: 883, y: 172 },
  { name: "LUTUF", x: 1218, y: 172 }, { name: "rahime", x: 548, y: 247 },
  { name: "Sihhat", x: 883, y: 247 }, { name: "WOOY", x: 1218, y: 247 },
  { name: "yeni amerika", x: 558, y: 322 },
];

// Sahte kopru: gercek tiklama yapmaz, cagrilari kaydeder.
function sahteKopru(ekstra = {}) {
  const cagrilar = [];
  return {
    cagrilar,
    async request({ action, payload }) {
      cagrilar.push({ action, payload });
      if (action === "screenshot") return { screenshotPath: "/tmp/ekran.png" };
      return { ok: true };
    },
    ...ekstra,
  };
}

// ---- YANLIS HEDEFE BAGLANMA: kirmizi cizgi ----

test("gorev ANNE iken baska hicbir karta tiklanmaz", async () => {
  const secim = hedefSec(CIHAZLAR, "ANNE");
  assert.equal(secim.ok, true);
  assert.equal(secim.device.name, "ANNE");
  // Kritik: secilen kartin KONUMU ANNE'nin kendi konumu olmali; baska
  // magazanin koordinati asla kullanilmamali.
  assert.equal(secim.device.x, 548);
  assert.equal(secim.device.y, 172);
  for (const yanlis of CIHAZLAR.filter((c) => c.name !== "ANNE")) {
    assert.notEqual(secim.device.x, yanlis.x === 548 ? -1 : yanlis.x, `${yanlis.name} konumu secilmemeli`);
  }
});

test("kismi/benzer ad KABUL EDILMEZ (canli hata: yanlis sunucu acildi)", () => {
  for (const kotu of ["ANN", "ANNE 2", "anne-yedek", "CanSel", "WOO", "yeni"]) {
    const s = hedefSec(CIHAZLAR, kotu);
    assert.equal(s.ok, false, `${kotu} icin baglanti acilmamali`);
    assert.equal(s.reason, "bulunamadi");
    assert.match(s.message, /hiçbirine bağlanılmadı|adında kayıtlı cihaz yok/);
  }
  // Buyuk/kucuk harf farki kabul edilir (ayni cihaz).
  assert.equal(hedefSec(CIHAZLAR, "anne").device.name, "ANNE");
  assert.equal(hedefSec(CIHAZLAR, "  WOOY ").device.name, "WOOY");
});

test("belirsiz eslesmede is DURUR", () => {
  const ikiz = [{ name: "ANNE", x: 1, y: 1 }, { name: "anne", x: 2, y: 2 }];
  const s = hedefSec(ikiz, "ANNE");
  assert.equal(s.ok, false);
  assert.equal(s.reason, "belirsiz");
  assert.match(s.message, /belirsizlikte bağlantı açılmaz/);
});

test("adEslesir toleranssizdir", () => {
  assert.equal(adEslesir("ANNE", "anne"), true);
  assert.equal(adEslesir(" ANNE ", "ANNE"), true);
  assert.equal(adEslesir("ANNE", "ANNE2"), false);
  assert.equal(adEslesir("ANNE", "ANNE yedek"), false);
  assert.equal(adEslesir("WOOY", "WOOY-2"), false);
});

test("baglanti yanlis hedefte hic tiklama yapmadan hata verir", async () => {
  const kopru = sahteKopru();
  const c = new RdpController("/tmp/ajan-rdp-test", { computerBridge: kopru });
  c.listele = async () => ({ devices: CIHAZLAR, sidebar: [] });
  await assert.rejects(() => c.baglan("ANN"), /kayıtlı cihaz yok/);
  const tiklamalar = kopru.cagrilar.filter((x) => /click/.test(x.action));
  assert.equal(tiklamalar.length, 0, "hedef doğrulanmadan TEK bir tıklama bile olmamalı");
  assert.equal(c.durum("ANN").connection_state, "hata");
  assert.match(c.durum("ANN").error, /kayıtlı cihaz yok/);
});

test("dogru hedefte kartin KENDI merkezine tiklanir (koordinat tahmini yok)", async () => {
  const kopru = sahteKopru();
  const c = new RdpController("/tmp/ajan-rdp-test", { computerBridge: kopru });
  c.listele = async () => ({ devices: CIHAZLAR, sidebar: [] });
  await c.baglan("Sihhat");
  const tik = kopru.cagrilar.find((x) => x.action === "double_click");
  assert.deepEqual(tik.payload, { x: 883, y: 247 }, "Sihhat kartinin kendi merkezi");
  assert.equal(c.durum("Sihhat").connection_state, "dogrulaniyor");
});

test("Favorites goruntusunde yanlis kart acilmasin: once Devices sekmesi", async () => {
  const kopru = sahteKopru();
  const c = new RdpController("/tmp/ajan-rdp-test", { computerBridge: kopru });
  c.listele = async () => ({ devices: CIHAZLAR, sidebar: [{ name: "Devices", x: 333, y: 144 }] });
  await c.baglan("WOOY");
  const ilkTik = kopru.cagrilar.find((x) => /click/.test(x.action));
  assert.deepEqual(ilkTik.payload, { x: 333, y: 144 }, "ilk tiklama Devices sekmesi olmali");
  const kartTik = kopru.cagrilar.find((x) => x.action === "double_click");
  assert.deepEqual(kartTik.payload, { x: 1218, y: 247 }, "sonra WOOY karti");
});

// ---- Durum makinesi ----

test("her sunucu icin istenen kalici alanlar tutulur", () => {
  const d = yeniDurum("ANNE", "ANNE-SRV");
  for (const alan of ["target_device", "expected_identity", "connection_state", "current_step",
    "last_screenshot", "findings", "started_at", "finished_at", "error"]) {
    assert.ok(alan in d, `${alan} alani olmali`);
  }
  assert.equal(d.expected_identity, "ANNE-SRV");
  assert.equal(d.connection_state, "hazir");
});

test("kimlik dogrulanmazsa gozleme GECILMEZ", async () => {
  const c = new RdpController("/tmp/ajan-rdp-test", { computerBridge: sahteKopru() });
  c.durumlar.set("ANNE", yeniDurum("ANNE"));
  const red = c.kimlikOnayla("ANNE", false, "Açılan masaüstü CanSelim görünüyor");
  assert.equal(red.connection_state, "hata");
  assert.match(red.error, /CanSelim|beklenen sunucu/);
  const kabul = c.kimlikOnayla("ANNE", true);
  assert.equal(kabul.connection_state, "gozlemde");
});

test("oturum kapanmadiysa siradaki sunucuya gecilmez", async () => {
  const kopru = sahteKopru();
  const c = new RdpController("/tmp/ajan-rdp-test", { computerBridge: kopru });
  c.durumlar.set("ANNE", yeniDurum("ANNE"));
  c.listele = async () => { throw new Error("liste yok"); };  // cihaz listesine donulemedi
  const sonuc = await c.kapat("ANNE");
  assert.equal(sonuc.connection_state, "hata");
  assert.match(sonuc.error, /GEÇİLMEZ/);
  c.listele = async () => ({ devices: CIHAZLAR, sidebar: [] });  // liste geri geldi
  const iyi = await c.kapat("ANNE");
  assert.equal(iyi.connection_state, "bitti");
  assert.equal(iyi.current_step, "cihaz listesine dönüldü");
});

// ---- Faz 1: yalniz gozlem ----

test("faz 1 eylem kumesinde yazma islemi YOK", () => {
  for (const yasak of ["iade_baslat", "siparis_ver", "mesaj_gonder", "dava_yanitla", "para_iadesi", "onayla", "gonder"]) {
    assert.ok(!GOZLEM_EYLEMLERI.includes(yasak), `${yasak} Faz 1'de olmamali`);
  }
  for (const gerekli of ["listele", "baglan", "ekran_al", "kapat"]) {
    assert.ok(GOZLEM_EYLEMLERI.includes(gerekli));
  }
  const kaynak = oku("src/rdpController.js");
  assert.ok(!/action: "type"/.test(kaynak), "Faz 1'de metin yazma olmamali");
});

test("parola modele verilmez: denetleyici kimlik bilgisi tasimaz", () => {
  const kaynak = oku("src/rdpController.js");
  for (const sizinti of ["password", "parola", "credential", "sifre"]) {
    const gecis = new RegExp(`${sizinti}\\s*[:=]`, "i");
    assert.ok(!gecis.test(kaynak), `${sizinti} alani denetleyicide olmamali`);
  }
  assert.match(kaynak, /yalniz KAYITLI CIHAZ ADINI secebilir/, "sinir belgelenmis olmali");
});

test("erisilebilirlik ANA yontem, koordinat son care", () => {
  const kaynak = oku("src/rdpController.js");
  assert.match(kaynak, /Erisilebilirlik agaci .*<-- oncelik/, "oncelik sirasi belgelenmeli");
  assert.match(kaynak, /Sabit koordinat  <-- yalniz son care/);
  assert.match(kaynak, /AXUIElementCreateApplication/, "AX agaci gercekten okunmali");
});

test("izole cagri ACIKCA verilen gorseli dusurmez (ekran gozlemi korlesmesin)", () => {
  const orch = oku("src/orchestrator.js");
  assert.match(orch, /opts\.isolated \? \(opts\.images \|\| \[\]\)/,
    "izole cagride cagiranin verdigi gorsel gecmeli");
  // Canli hata: uye "Görüntü olmadığı için kimlik doğrulanamaz" dedi ve
  // guvenli varsayilan devreye girip oturum kapandi.
  assert.match(orch, /uye "görüntü yok"/, "sebep koda not dusulmus olmali");
});

// ---- Sertifika penceresi: adres sabitleme ----
test("sertifika penceresinden sunucu adresi ve dugmeler okunur", async () => {
  const { sertifikaPenceresi } = await import("../src/rdpController.js");
  const metin = ['You are connecting to the RDP host "87.76.130.141". The certificate couldn\'t be verified back to a root certificate. Do you want to continue?'];
  const dugmeler = [{ name: "Show Certificate", x: 1, y: 1 }, { name: "Cancel", x: 2, y: 2 }, { name: "Continue", x: 3, y: 3 }];
  const p = sertifikaPenceresi(metin, dugmeler);
  assert.equal(p.host, "87.76.130.141");
  assert.deepEqual(p.devam, { name: "Continue", x: 3, y: 3 }, "dogru dugme AX'ten gelmeli, koordinat tahmini degil");
  assert.equal(sertifikaPenceresi(["Sıradan bir metin"], dugmeler), null, "sertifika olmayan pencere yakalanmamali");
});

test("sertifika uyarisi OTOMATIK gecilir ve adres ilk goruste sabitlenir", async () => {
  const kopru = sahteKopru();
  const dir = fs.mkdtempSync("/tmp/ajan-pin-");
  const c = new RdpController(dir, { computerBridge: kopru });
  c.listele = async () => ({ devices: CIHAZLAR, sidebar: [],
    buttons: [{ name: "Continue", x: 3, y: 3 }],
    texts: ['You are connecting to the RDP host "87.76.130.141". The certificate...'] });
  const karar = await c.sertifikaKarari("ANNE");
  assert.equal(karar.durum, "gecildi", "kullanicinin kendi sunucusunda onay beklenmez");
  assert.deepEqual(kopru.cagrilar[0], { action: "click", payload: { x: 3, y: 3 } },
    "Continue dugmesine AX konumundan basilmali");
  assert.equal(c.pinleriOku().ANNE.host, "87.76.130.141", "adres sabitlenmeli");
  assert.equal(karar.uyari, null, "ilk goruste uyari olmamali");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("adres degisirse baglanti acilir ama YUKSEK ONEMLI uyari duser", async () => {
  const kopru = sahteKopru();
  const dir = fs.mkdtempSync("/tmp/ajan-pin-");
  const c = new RdpController(dir, { computerBridge: kopru });
  c.durumlar.set("ANNE", yeniDurum("ANNE"));
  c.pinYaz("ANNE", "87.76.130.141");
  c.listele = async () => ({ devices: CIHAZLAR, sidebar: [],
    buttons: [{ name: "Continue", x: 3, y: 3 }],
    texts: ['You are connecting to the RDP host "203.0.113.9". The certificate...'] });
  const karar = await c.sertifikaKarari("ANNE");
  assert.equal(karar.durum, "gecildi", "is durmamali (kullanici karari)");
  assert.match(karar.uyari, /adresi değişmiş.*87\.76\.130\.141.*203\.0\.113\.9/,
    "degisiklik sessiz gecmemeli");
  const bulgu = c.durum("ANNE").findings.at(-1);
  assert.equal(bulgu.onem, "yuksek", "uyari yuksek onemli bulgu olarak kaydedilmeli");
  assert.equal(c.pinleriOku().ANNE.host, "203.0.113.9", "yeni adres sabitlenmeli");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("onay dugmesi okunamazsa korukoru tiklanmaz", async () => {
  const kopru = sahteKopru();
  const dir = fs.mkdtempSync("/tmp/ajan-pin-");
  const c = new RdpController(dir, { computerBridge: kopru });
  c.listele = async () => ({ devices: CIHAZLAR, sidebar: [], buttons: [],
    texts: ['You are connecting to the RDP host "87.76.130.141". The certificate...'] });
  const karar = await c.sertifikaKarari("ANNE");
  assert.equal(karar.durum, "belirsiz");
  assert.equal(kopru.cagrilar.length, 0, "dugme bilinmiyorsa tahminle tiklanmamali");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sertifika penceresi gecikince kacirilmaz (araliklarla bakilir)", async () => {
  const kopru = sahteKopru();
  const dir = fs.mkdtempSync("/tmp/ajan-pin-");
  const c = new RdpController(dir, { computerBridge: kopru });
  let cagri = 0;
  // Pencere 3. bakista cikiyor — canli davranis buydu.
  c.listele = async () => {
    cagri += 1;
    return cagri < 3
      ? { devices: CIHAZLAR, sidebar: [], buttons: [], texts: [] }
      : { devices: CIHAZLAR, sidebar: [], buttons: [{ name: "Continue", x: 3, y: 3 }],
          texts: ['You are connecting to the RDP host "87.76.130.141". The certificate...'] };
  };
  const karar = await c.sertifikaKarari("ANNE", { deneme: 5, araSaniye: 0 });
  assert.equal(karar.durum, "gecildi", "gec cikan pencere de yakalanmali");
  assert.equal(karar.host, "87.76.130.141");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("uyeye ekran goruntusu hem EK hem YOL olarak verilir", () => {
  const opsRun = oku("src/opsRun.js");
  assert.match(opsRun, /EKRAN GÖRÜNTÜSÜ DOSYASI: \$\{ekranYolu\}/, "yol istemde gecmeli");
  assert.match(opsRun, /images: ekranYolu/, "ek olarak da verilmeli");
  const orch = oku("src/orchestrator.js");
  assert.match(orch, /görüntü\/dosya eklerini okuman serbesttir/,
    "izole cagride verilen gorseli okumak serbest olmali");
});

test("AX yardimcisi kaynak degisince yeniden derlenir (eski ikili takili kalmasin)", () => {
  const kaynak = oku("src/rdpController.js");
  assert.match(kaynak, /axcihazlar\.imza/, "surum imzasi tutulmali");
  assert.match(kaynak, /eski ikilinin takili kalmasina yol aciyordu/, "sebep koda not dusulmus olmali");
  // Canli hata: yeni alanlar (dialog dugmeleri/metinleri) hic gelmedi cunku
  // "dosya var mi" kontrolu eski ikiliyi kullanmaya devam ediyordu.
});
