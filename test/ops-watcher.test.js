import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { OpsWatcher, kayitlariCikar } from "../src/opsWatcher.js";
import { OpsJobs } from "../src/opsJobs.js";

const oku = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

const SAHTE_PANEL = {
  connected: () => true,
  overview: async () => ({
    returns: { items: [{ return_id: "5327577132", acik: true, urunAdi: "Pizza Sauce",
      sebepAdi: "Ürün ulaşmadı", kalanGun: 1, order_id: "09-15047-77014" }] },
    cases: { items: [{ case_id: "CASE-9", status: "OPEN", type: "inquiry", item_title: "Kablo" }] },
    work: { groups: [{ key: "orders", items: [{ ebay_order_id: "25-15054-69020", title: "Kablo",
      detail: "Hazırlanmayı bekliyor" }] }] },
  }),
};

test("panel kayitlari tek bicime cevrilir", () => {
  const iadeler = kayitlariCikar("returns", { items: [{ return_id: "R1", urunAdi: "Ürün", kalanGun: 1 }] });
  assert.equal(iadeler[0].isTuru, "amazon_iade");
  assert.equal(iadeler[0].varlikId, "R1");
  assert.equal(iadeler[0].onem, "yuksek", "2 gun ve alti acil olmali");
  const gec = kayitlariCikar("returns", { items: [{ return_id: "R2", kalanGun: 9 }] });
  assert.equal(gec[0].onem, "orta");
  // Kimliksiz kayit atilir (idempotens anahtari uretilemez).
  assert.equal(kayitlariCikar("returns", { items: [{ urunAdi: "kimliksiz" }] }).length, 0);
});

test("canli kayitlar ISE donusur, ayni kayit TEKRAR donusmez", async () => {
  const jobs = new OpsJobs();
  const w = new OpsWatcher({ canseller: SAHTE_PANEL, jobs, store: null });
  w.hesap = "ANNE";
  // BOOTSTRAP: ilk tur yalniz taban cikarir, is ACMAZ (kuyruk patlamasin).
  const ilk = await w.yokla();
  assert.equal(ilk.yeni, 0, "ilk tur mevcut kayitlari ise donusturmemeli");
  assert.equal(w.gorulen.size, 3, "ama hepsi izlemeye alinmali");
  // Ikinci turda ayni kayitlar YINE is acmaz (gercekten yeni degiller).
  const ikinci = await w.yokla();
  assert.equal(ikinci.yeni, 0, "ayni kayitlar ise donmemeli");
  // GERCEKTEN yeni bir kayit gelirse is acilir.
  const jobsOnce = jobs.liste().length;
  w.canseller = { connected: () => true, overview: async () => ({
    returns: { items: [{ return_id: "YENI-1", acik: true, urunAdi: "Yeni iade" }] }, cases: null, work: null }) };
  const ucuncu = await w.yokla();
  assert.equal(ucuncu.yeni, 1, "bootstrap sonrasi yeni kayit ise donmeli");
  assert.equal(jobs.liste().length, jobsOnce + 1);
  assert.ok(jobs.liste().length >= 1, "yeni kayit ise donmeli");
});

test("OLGUNLASMA penceresi: yeni kayit hemen yurutulmez", async () => {
  const jobs = new OpsJobs();
  const w = new OpsWatcher({ canseller: SAHTE_PANEL, jobs, store: null, ayar: { olgunlasmaMs: 50 } });
  w.hesap = "ANNE";
  await w.yokla();
  assert.equal(w.olgunMu("amazon_iade", "5327577132"), false, "yeni kayit beklemeli");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(w.olgunMu("amazon_iade", "5327577132"), true, "sure dolunca olgun olmali");
  // Izleyicinin gormedigi (elle acilmis) is beklemez.
  assert.equal(w.olgunMu("amazon_iade", "BASKA"), true);
});

test("kapanan kayit izlemeden dusurulur (bellek sismesin)", async () => {
  const jobs = new OpsJobs();
  let acik = true;
  const panel = { connected: () => true, overview: async () => ({
    returns: { items: [{ return_id: "R9", acik, urunAdi: "X" }] }, cases: null, work: null }) };
  const w = new OpsWatcher({ canseller: panel, jobs, store: null });
  w.hesap = "ANNE";
  await w.yokla();
  assert.equal(w.gorulen.size, 1);
  acik = false;                    // iade kapandi
  await w.yokla();
  assert.equal(w.gorulen.size, 0, "kapanan kayit izlemede kalmamali");
});

test("oturum dusunce izleyici sessizce calismaya devam etmez", async () => {
  const jobs = new OpsJobs();
  const w = new OpsWatcher({ canseller: { connected: () => false }, jobs, store: null });
  const sonuc = await w.yokla();
  assert.equal(sonuc.ok, false);
  assert.match(w.durum().sonHata, /oturumu düştü/);
  assert.equal(w.baslat("ANNE").ok, false, "baglanti yokken baslamamali");
});

test("olgunlasma gerekcesi kaynakta belgeli", () => {
  const kaynak = oku("src/opsWatcher.js");
  assert.match(kaynak, /CanSellerAI SENSOR, uzak masaustu EL/, "rol dagilimi yazili olmali");
  assert.match(kaynak, /yarim veriyle islem baslatmak/i, "erken mudahale riski yazili olmali");
  assert.match(kaynak, /gorur gormez KUYRUGA alinir/i, "kayit kacirilmamali");
});

// ---- COK HESAPLI IZLEME (kullanici: zeynep haric tum hesaplar) ----

function cokHesapPanel() {
  let secili = null;
  return {
    secili: () => secili,
    connected: () => true,
    accounts: async () => [{ id: 1, name: "ANNE" }, { id: 2, name: "CanSelim" },
      { id: 3, name: "zeynep" }, { id: 4, name: "WOOY" }],
    switchAccount: async (id) => { secili = id; return { ok: true }; },
    overview: async () => ({ returns: { items: [{ return_id: "R" + secili, acik: true, urunAdi: "Ürün" }] },
      cases: null, work: null }),
  };
}

test("zeynep HARIC tum hesaplar taranir", async () => {
  const jobs = new OpsJobs();
  const panel = cokHesapPanel();
  const w = new OpsWatcher({ canseller: panel, jobs, store: null });
  const r = await w.tumunuYokla();
  assert.equal(r.hesaplar, 3, "dort hesaptan zeynep dislanmali");
  const adlar = r.sonuclar.map((s) => s.hesap);
  assert.deepEqual(adlar, ["ANNE", "CanSelim", "WOOY"]);
  assert.ok(!adlar.includes("zeynep"), "zeynep hesabina HIC gecilmemeli");
  // Ilk tur bootstrap oldugu icin is acilmaz; hepsi izlemeye girer.
  assert.equal(w.gorulen.size, 3, "uc magazanin kaydi da izlenmeli");
});

test("bir magaza hata verirse digerleri taranmaya devam eder", async () => {
  const jobs = new OpsJobs();
  const panel = cokHesapPanel();
  panel.switchAccount = async (id) => { if (id === 2) throw new Error("panel kapalı"); return { ok: true }; };
  const w = new OpsWatcher({ canseller: panel, jobs, store: null });
  const r = await w.tumunuYokla();
  assert.equal(r.hesaplar, 3, "hatali magaza da sonuclarda gorunmeli");
  const hatali = r.sonuclar.find((s) => s.hesap === "CanSelim");
  assert.equal(hatali.ok, false);
  assert.match(hatali.hata, /panel kapalı/);
  assert.ok(r.sonuclar.filter((s) => s.ok !== false).length >= 2, "digerleri taranmali");
});

test("haric listesi buyuk/kucuk harf ve bosluga takilmaz", () => {
  const w = new OpsWatcher({ canseller: {}, jobs: new OpsJobs(), store: null, haric: ["zeynep"] });
  assert.equal(w.haricMi("zeynep"), true);
  assert.equal(w.haricMi("  ZEYNEP "), true);
  assert.equal(w.haricMi("Zeynep"), true);
  assert.equal(w.haricMi("zeynep2"), false, "benzer ad haric sayilmamali");
  assert.equal(w.haricMi("ANNE"), false);
});

// ---- OTURUM KALICILIGI ----

test("oturum diske 0600 ile yazilir, parola YAZILMAZ", async () => {
  const fsm = await import("node:fs");
  const os = await import("node:os");
  const pathm = await import("node:path");
  const { CanSellerAI } = await import("../src/cansellerai.js");
  const dir = fsm.mkdtempSync(pathm.join(os.tmpdir(), "ops-oturum-"));
  const c = new CanSellerAI({ dataRoot: dir, fetchImpl: async () => ({
    ok: true, status: 200, headers: { getSetCookie: () => ["cansellerai_hub=GIZLI; HttpOnly"] }, json: async () => ({}) }) });
  await c.login("admin", "PAROLA123");
  const dosya = pathm.join(dir, "canseller-oturum.json");
  assert.ok(fsm.existsSync(dosya), "oturum diske yazilmali");
  const izin = (fsm.statSync(dosya).mode & 0o777).toString(8);
  assert.equal(izin, "600", "yalniz kullanici okuyabilmeli");
  const icerik = fsm.readFileSync(dosya, "utf8");
  assert.ok(!icerik.includes("PAROLA123"), "PAROLA diske YAZILMAMALI");
  // Yeniden baslatma benzetimi: yeni ornek oturumu geri yukler.
  const c2 = new CanSellerAI({ dataRoot: dir });
  assert.equal(c2.connected(), false, "yuklemeden once bagli olmamali");
  c2.oturumuYukle();
  assert.equal(c2.connected(), true, "uygulama yeniden baslayinca oturum surmeli");
  // Cikis dosyayi da siler.
  c2.cikis();
  assert.ok(!fsm.existsSync(dosya), "cikista oturum dosyasi silinmeli");
  fsm.rmSync(dir, { recursive: true, force: true });
});

test("cok hesapli izlemede baska magazanin izi SILINMEZ", async () => {
  const jobs = new OpsJobs();
  const panel = cokHesapPanel();
  const w = new OpsWatcher({ canseller: panel, jobs, store: null });
  await w.tumunuYokla();
  assert.equal(w.gorulen.size, 3, "uc magazanin kaydi da izlenmeli");
  // Ikinci tur: ayni kayitlar hala izlenmeli, "yeni" sayilmamali.
  const r = await w.tumunuYokla();
  assert.equal(r.yeni, 0, "ayni kayitlar tekrar is acmamali");
  assert.equal(w.gorulen.size, 3, "izler korunmali");
});

test("durum kusagi: kaydin DURUMU degisince yeni is acilir", async () => {
  const { idempotensAnahtari } = await import("../src/opsJobs.js");
  // Ayni iade, farkli durum -> AYRI anahtar (gecis yutulmasin).
  assert.notEqual(
    idempotensAnahtari("amazon_iade", "ANNE", "R1", "acik"),
    idempotensAnahtari("amazon_iade", "ANNE", "R1", "etiket-bekliyor"));
  // Durum verilmezse eski bicim korunur (geriye uyum).
  assert.equal(idempotensAnahtari("amazon_iade", "ANNE", "R1"), "amazon_iade:ANNE:R1");
  const kaynak = oku("src/opsJobs.js");
  assert.match(kaynak, /GECISI yutulur/, "gerekce kaynakta olmali");
});

test("BOOTSTRAP: ilk tur kuyrugu patlatmaz", () => {
  const kaynak = oku("src/opsWatcher.js");
  assert.match(kaynak, /ilk acilista yuzlerce MEVCUT kayit birden/, "gerekce yazili olmali");
  assert.match(kaynak, /if \(this\.ilkTur\) continue;/, "ilk tur is acmamali");
});
