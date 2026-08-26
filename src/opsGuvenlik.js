// Operasyon guvenlik kapilari — konsey kararinin uygulamasi.
//
// Konsey (run-d8f784ec) dort uyeyle "karma" karar verdi: tek bir uyenin
// paketi yeterli degil, uc eksen birbirini tamamliyor. Bu dosya o kararin
// KOD tarafi: her parca, sistemin sessizce yanlis is yapabilecegi somut bir
// deligi kapatir.
//
// 1) KILL-SWITCH (Codex)      — dosya varsa hicbir is yurutulmez.
// 2) DEVRE KESICI (Codex)     — bir magazada ust uste hata olursa o magaza
//                               kapanir; ayni hatayi 7 magazada tekrarlamaz.
// 3) BAGLAM MUHRU (Antigravity) — geri alinamaz TIKLAMADAN hemen once ekran
//                               yeniden okunur. Bugunku kimlik dogrulamasi
//                               yalniz OTURUM ACILISINDA yapiliyor; sihirbaz
//                               ortasinda odak baska pencereye kayarsa
//                               kimse gormuyor. En pahali hata sinifi bu.
// 4) MESAJ FILTRESI (Antigravity) — platform disina yonlendirme ve puan
//                               isteme iceren mesaj GONDERILMEZ.
// 5) policy_verified (Claude) — bir is turunun faz kapisi, o turun politika
//                               metni bir INSAN tarafindan okunup kayda
//                               gecmeden acilamaz.
//
// Konseyin ELEDIKLERI de bilincli olarak burada YOK:
// - Medyan tabanli parasal esik: medyan "kabul edilebilir zarar" degil,
//   dagilimin ortasi. Parasal karar, sahibi limit koyana dek onayda kalir.
// - Hiz tavani / rastgele gecikme: bu bir uyum onlemi degil, tespit
//   mekanizmasindan kacinma yaklasimidir. Kalici olarak dusuruldu.

import fs from "node:fs";
import path from "node:path";

// ---- 1) KILL-SWITCH ----------------------------------------------------
// Neden dosya tabanli: uygulama kilitlense, arayuz acilmasa, hatta surec
// cevap vermese bile kullanici tek komutla her seyi durdurabilmeli.
//   touch ~/.ajan-konseyi/DUR
export class KillSwitch {
  constructor(dataRoot) { this.dosya = path.join(dataRoot || "", "DUR"); }
  aktifMi() { try { return fs.existsSync(this.dosya); } catch { return false; } }
  sebep() {
    try { return String(fs.readFileSync(this.dosya, "utf8")).trim() || "elle durduruldu"; }
    catch { return "elle durduruldu"; }
  }
  bas(sebep = "elle durduruldu") {
    fs.mkdirSync(path.dirname(this.dosya), { recursive: true });
    fs.writeFileSync(this.dosya, String(sebep));
    return { ok: true };
  }
  kaldir() { try { fs.unlinkSync(this.dosya); } catch {} return { ok: true }; }
}

// ---- 2) MAGAZA DEVRE KESICI -------------------------------------------
// Bir magazada ust uste N hata = o magazada yapisal bir sorun var (oturum
// dusmus, panel degismis, sunucu yavas). Denemeye devam etmek ayni hatayi
// cogaltir. Kesici ATILINCA yalniz O magaza kapanir; digerleri calisir.
export const KESICI_ESIK = 3;
export const KESICI_SURE_MS = 30 * 60_000;   // 30 dk sonra tekrar dene

export class DevreKesici {
  constructor({ esik = KESICI_ESIK, sureMs = KESICI_SURE_MS } = {}) {
    this.esik = esik; this.sureMs = sureMs;
    this.sayac = new Map();   // magaza -> {hata, acildi}
  }
  _kayit(magaza) {
    const ad = String(magaza || "?");
    if (!this.sayac.has(ad)) this.sayac.set(ad, { hata: 0, acildi: null });
    return this.sayac.get(ad);
  }
  hata(magaza, sebep = "") {
    const k = this._kayit(magaza);
    k.hata += 1; k.sonSebep = sebep;
    if (k.hata >= this.esik && !k.acildi) k.acildi = Date.now();
    return this.durum(magaza);
  }
  // BASARI kesiciyi sifirlar: gecici bir sorun kalici sayilmasin.
  basari(magaza) { const k = this._kayit(magaza); k.hata = 0; k.acildi = null; return this.durum(magaza); }
  kapaliMi(magaza) {
    const k = this._kayit(magaza);
    if (!k.acildi) return false;
    if (Date.now() - k.acildi >= this.sureMs) { k.acildi = null; k.hata = 0; return false; }
    return true;
  }
  durum(magaza) {
    const k = this._kayit(magaza);
    return { magaza: String(magaza || "?"), hata: k.hata, kapali: this.kapaliMi(magaza),
      sonSebep: k.sonSebep || null,
      kalanMs: k.acildi ? Math.max(0, this.sureMs - (Date.now() - k.acildi)) : 0 };
  }
  hepsi() { return [...this.sayac.keys()].map((m) => this.durum(m)); }
}

// ---- 3) BAGLAM MUHRU ---------------------------------------------------
// Geri alinamaz tiklamadan HEMEN ONCE ekran yeniden okunur ve su uc sey
// beklenenle karsilastirilir: hangi magaza (pencere basligi), hangi kayit
// (siparis/iade numarasi ekranda goruluyor mu), hangi dugme (metni dogru mu).
// Uc kosuldan biri tutmazsa TIKLAMA YAPILMAZ.
export function muhurKontrol(beklenen, ekran) {
  const eksik = [];
  const bas = String(ekran?.pencereBasligi || "");
  const metin = String(ekran?.metin || "");
  const dugme = String(ekran?.dugme || "");

  const magaza = String(beklenen?.magaza || "");
  if (!magaza) eksik.push("beklenen mağaza belirtilmemiş");
  else if (!bas) eksik.push("pencere başlığı okunamadı");
  else if (bas.trim().toLocaleLowerCase("tr-TR") !== magaza.trim().toLocaleLowerCase("tr-TR")) {
    eksik.push(`pencere "${bas}" — beklenen "${magaza}"`);
  }

  const varlikId = String(beklenen?.varlikId || "");
  if (varlikId && !metin.includes(varlikId)) eksik.push(`kayıt ${varlikId} ekranda görünmüyor`);

  const beklenenDugme = String(beklenen?.dugme || "");
  if (beklenenDugme && dugme.trim().toLocaleLowerCase("en-US") !== beklenenDugme.trim().toLocaleLowerCase("en-US")) {
    eksik.push(`düğme "${dugme}" — beklenen "${beklenenDugme}"`);
  }

  return eksik.length
    ? { ok: false, eksik, mesaj: `Bağlam mührü tutmadı: ${eksik.join("; ")}` }
    : { ok: true, muhur: `${magaza}:${varlikId || "-"}:${beklenenDugme || "-"}` };
}

// ---- 4) MESAJ ICERIK FILTRESI -----------------------------------------
// Alici mesajlarinda platform disina yonlendirme ve puan isteme yasak.
// Filtre GONDERIM ONCESI calisir; takilan mesaj gonderilmez, kullaniciya
// duser. Amac: ajan iyi niyetle "bize whatsapp'tan yazin" ya da "5 yildiz
// verirseniz seviniriz" yazip magazayi riske atmasin.
const YASAK_DESENLER = Object.freeze([
  { ad: "e-posta adresi", desen: /[\w.+-]+@[\w-]+\.[\w.]{2,}/u },
  // En az 10 rakamlik dizi (aralarinda bosluk/tire/parantez olabilir).
  // Siparis numaralari tire ile ayrilmis sabit bicimlerdir ve mesaj metninde
  // gecmesi normaldir; bu yuzden ondalik/kisa dizilere degil, TELEFON
  // uzunlugundaki serbest rakam dizisine bakilir.
  { ad: "telefon numarası", desen: /(?:\+?\d[\d\s().-]{8,}\d)/u },
  { ad: "harici bağlantı", desen: /\b(?:https?:\/\/|www\.)(?!(?:www\.)?(?:ebay|amazon)\.)[^\s]+/iu },
  { ad: "mesajlaşma uygulaması", desen: /\b(whatsapp|telegram|instagram|skype)\b/iu },
  { ad: "puan/geri bildirim isteme", desen: /(5\s*(yıldız|star)|olumlu\s*(geri\s*bildirim|puan|yorum)|positive\s*feedback|leave\s+(?:us\s+)?a?\s*review)/iu },
  { ad: "platform dışına yönlendirme", desen: /(dışarıdan|platform\s*dışı|off[- ]?(?:ebay|amazon)|doğrudan\s*(?:bize\s*)?(?:yaz|ulaş|öde))/iu },
]);

// Siparis/iade numaralari mesajda GECMESI NORMAL olan uzun rakam dizileridir
// ("Siparis 112-3456789-1234567 kargoya verildi"). Telefon taramasindan
// once bunlar cikarilir, yoksa her mesaj yanlislikla takilir.
const NUMARA_BICIMLERI = /\b(?:\d{3}-\d{7}-\d{7}|\d{2}-\d{5}-\d{5}|1Z[0-9A-Z]{16})\b/g;

export function mesajFiltresi(metin) {
  const m = String(metin || "").replace(NUMARA_BICIMLERI, " [numara] ");
  const takilan = YASAK_DESENLER.filter((d) => d.desen.test(m)).map((d) => d.ad);
  return takilan.length
    ? { ok: false, takilan, mesaj: `Mesaj gönderilmedi — yasaklı içerik: ${takilan.join(", ")}` }
    : { ok: true };
}

// ---- 5) policy_verified ------------------------------------------------
// Konsey su gercegi ortaya cikardi: Amazon'un ve eBay'in otomasyon
// hukumleri bot erisimine kapali sayfalarda; alinti uretmek UYDURMAK olur.
// Cozum kaynagi uydurmak degil, dogrulamayi KODDA KISITA cevirmek: bir is
// turunun politika metni bir insan tarafindan okunup kayda gecmeden o turun
// faz kapisi acilamaz.
export class PolitikaKaydi {
  constructor(dataRoot) {
    this.dosya = path.join(dataRoot || "", "politika-dogrulama.json");
    this.kayit = {};
    this.yukle();
  }
  yukle() {
    try { this.kayit = JSON.parse(fs.readFileSync(this.dosya, "utf8")) || {}; }
    catch { this.kayit = {}; }
    return this.kayit;
  }
  _yaz() {
    try {
      fs.mkdirSync(path.dirname(this.dosya), { recursive: true });
      fs.writeFileSync(this.dosya, JSON.stringify(this.kayit, null, 2));
    } catch {}
  }
  // Kullanici politika metnini KENDI okur ve buraya gecer: belge basligi,
  // baglanti, yururluk tarihi. Bos gecilemez — "onayladim" demek yetmez.
  dogrula(isTuru, { belge, baglanti, tarih, notlar = "" } = {}) {
    if (!belge || !baglanti || !tarih) {
      return { ok: false, mesaj: "Belge başlığı, bağlantı ve yürürlük tarihi zorunlu." };
    }
    this.kayit[String(isTuru)] = { belge, baglanti, tarih, notlar, kaydedildi: new Date().toISOString() };
    this._yaz();
    return { ok: true, kayit: this.kayit[String(isTuru)] };
  }
  geriAl(isTuru) { delete this.kayit[String(isTuru)]; this._yaz(); return { ok: true }; }
  dogrulandiMi(isTuru) { return Boolean(this.kayit[String(isTuru)]); }
  durum() {
    return { dogrulanan: Object.keys(this.kayit), kayitlar: this.kayit };
  }
}
