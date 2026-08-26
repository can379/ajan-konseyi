// Operasyon is kuyrugu ve KANIT SOZLESMESI.
//
// Konsey tasarim turunun (run-b7d754dd) iki temel karari buraya gomuldu:
//
//   1) "Karar veriyi CanSellerAI'da uret, tiklamayi ekranda yap. Ekran
//      otomasyonu EYLEM ORGANIDIR, BEYIN DEGIL. Ekrandan okunan hicbir sey
//      tek basina gercek sayilmaz; CanSellerAI kaydiyla eslesmezse is durur."
//
//   2) "Bir is yalniz COMMITTED kanit kaydi yazildiysa basarilidir.
//      'Dugmeye bastim' basari degildir. Kanit yoksa durum UNKNOWN'dur ve
//      IKINCI DENEME YAPILMAZ — uzlastirma kuyruguna gider."
//
// Ikinci kural bu isin kalbi: cift siparis, cift iade ve cift para hareketi
// tam olarak "sonuc belirsiz kaldi, bir daha deneyelim" anindan dogar.

import crypto from "node:crypto";

// Is durumlari. UNKNOWN bilerek BASARISIZ'dan ayridir: basarisiz is yeniden
// denenebilir, UNKNOWN denenemez — once dis sistemde ne oldugu okunmalidir.
export const IS_DURUM = Object.freeze({
  KUYRUKTA: "kuyrukta",
  KIRALANDI: "kiralandi",
  CALISIYOR: "calisiyor",
  SAYFA_BEKLIYOR: "sayfa-bekliyor",
  KULLANICI_BEKLIYOR: "kullanici-bekliyor",
  DOGRULANIYOR: "dogrulaniyor",
  TAMAM: "tamam",
  YENIDEN_DENENEBILIR: "yeniden-denenebilir",
  KALICI_HATA: "kalici-hata",
  BELIRSIZ: "belirsiz",          // UNKNOWN — dis sistem okunmadan tekrar YOK
  IPTAL: "iptal",
});

// Her is turu icin ZORUNLU kanit alanlari. Eksikse is TAMAM sayilmaz.
// Kaynak: konseyin kanit sozlesmesi tablosu.
export const KANIT_SOZLESMESI = Object.freeze({
  amazon_siparis: {
    zorunlu: ["ebayOrderId", "amazonOrderId", "asin", "adet", "tutar"],
    bicim: { amazonOrderId: /^\d{3}-\d{7}-\d{7}$/ },
    caprazDogrulama: "Amazon sipariş geçmişinde aynı order ID ve tutar görünmeli",
  },
  stok_yok_mesaji: {
    zorunlu: ["ebayOrderId", "aliciId", "mesajId", "sablonSurumu", "gonderimZamani"],
    caprazDogrulama: "Mesaj, ilgili sipariş ekranındaki yazışmada görünmeli",
  },
  amazon_iade: {
    zorunlu: ["ebayOrderId", "amazonOrderId", "rma", "iadeYontemi", "kargoUcretsiz", "etiketKimligi"],
    bicim: { iadeYontemi: /^(orijinal-kart|kart)$/i },
    caprazDogrulama: "Amazon Returns geçmişi ile eBay iade kaydındaki taşıyıcı/RMA eşleşmeli",
  },
  ebay_dava: {
    zorunlu: ["davaId", "ebayOrderId", "aliciId", "kanitPaketiHash"],
    caprazDogrulama: "Gönderim sonrası eBay dava durumu değişmiş olmalı",
  },
});

// Idempotens anahtari: ayni is ikinci kez KUYRUGA GIRMEZ.
// Bicim: <isTuru>:<hesap>:<varlikId>
export function idempotensAnahtari(isTuru, hesap, varlikId) {
  const parca = [isTuru, hesap, varlikId].map((x) => String(x || "").trim()).filter(Boolean);
  if (parca.length !== 3) throw new Error("Idempotens anahtarı için iş türü, hesap ve varlık kimliği şart");
  return parca.join(":");
}

// Kanit dogrulama: eksik alan veya bicim hatasi varsa is TAMAM olamaz.
export function kanitDogrula(isTuru, kanit) {
  const sozlesme = KANIT_SOZLESMESI[isTuru];
  if (!sozlesme) return { ok: false, eksik: [], hata: `Tanımsız iş türü: ${isTuru}` };
  const eksik = sozlesme.zorunlu.filter((alan) => {
    const deger = kanit?.[alan];
    return deger === undefined || deger === null || String(deger).trim() === "";
  });
  const bicimHatasi = Object.entries(sozlesme.bicim || {})
    .filter(([alan, desen]) => kanit?.[alan] && !desen.test(String(kanit[alan])))
    .map(([alan]) => alan);
  if (eksik.length || bicimHatasi.length) {
    return { ok: false, eksik, bicimHatasi,
      hata: [eksik.length ? `eksik kanıt: ${eksik.join(", ")}` : "",
             bicimHatasi.length ? `biçim hatası: ${bicimHatasi.join(", ")}` : ""].filter(Boolean).join(" · ") };
  }
  return { ok: true, caprazDogrulama: sozlesme.caprazDogrulama };
}

export class OpsJobs {
  constructor({ kayitYolu = null } = {}) {
    this.isler = new Map();       // id -> is
    this.anahtarlar = new Map();  // idempotens anahtari -> is id
    this.kayitYolu = kayitYolu;
  }

  liste({ durum = null, hesap = null } = {}) {
    return [...this.isler.values()]
      .filter((i) => (!durum || i.durum === durum) && (!hesap || i.hesap === hesap))
      .sort((a, b) => String(b.olusturuldu).localeCompare(String(a.olusturuldu)));
  }

  bul(id) { return this.isler.get(id) || null; }

  // Is ekleme: ayni idempotens anahtariyla ikinci is ACILMAZ.
  ekle({ isTuru, hesap, varlikId, risk = 3, veri = {} }) {
    const anahtar = idempotensAnahtari(isTuru, hesap, varlikId);
    const mevcutId = this.anahtarlar.get(anahtar);
    if (mevcutId) {
      const mevcut = this.isler.get(mevcutId);
      return { ok: false, yinelenen: true, is: mevcut,
        mesaj: `Bu iş zaten var (${mevcut.durum}); ikinci kez açılmadı: ${anahtar}` };
    }
    const is = {
      id: "is-" + crypto.randomBytes(5).toString("hex"),
      isTuru, hesap, varlikId, risk, veri,
      anahtar,
      durum: IS_DURUM.KUYRUKTA,
      deneme: 0,
      kanit: null,
      kiralayan: null,
      kiraBitis: null,
      hata: null,
      olusturuldu: new Date().toISOString(),
      guncellendi: new Date().toISOString(),
      gecmis: [{ at: new Date().toISOString(), durum: IS_DURUM.KUYRUKTA, not: "kuyruğa alındı" }],
    };
    this.isler.set(is.id, is);
    this.anahtarlar.set(anahtar, is.id);
    return { ok: true, is };
  }

  _gecir(is, durum, not = "") {
    is.durum = durum;
    is.guncellendi = new Date().toISOString();
    is.gecmis.push({ at: is.guncellendi, durum, not });
    if (is.gecmis.length > 60) is.gecmis.shift();
    return is;
  }

  // Kiralama: ayni is iki yerde birden calismaz. Kira suresi dolarsa is
  // serbest kalir (calisan surec olmus olabilir).
  kirala(id, sahip, ttlMs = 15 * 60_000) {
    const is = this.isler.get(id);
    if (!is) return { ok: false, mesaj: "İş bulunamadı" };
    const simdi = Date.now();
    if (is.kiralayan && is.kiraBitis > simdi && is.kiralayan !== sahip) {
      return { ok: false, mesaj: `İş şu an ${is.kiralayan} tarafından yürütülüyor` };
    }
    is.kiralayan = sahip;
    is.kiraBitis = simdi + ttlMs;
    is.deneme += 1;
    this._gecir(is, IS_DURUM.KIRALANDI, `kiralayan: ${sahip} (deneme ${is.deneme})`);
    return { ok: true, is };
  }

  // BITIRME — kanit sozlesmesinin uygulandigi yer.
  // Kanit eksikse is TAMAM olmaz; BELIRSIZ'e duser ve bir daha DENENMEZ.
  bitir(id, { kanit = null, not = "" } = {}) {
    const is = this.isler.get(id);
    if (!is) return { ok: false, mesaj: "İş bulunamadı" };
    const dogrulama = kanitDogrula(is.isTuru, kanit || {});
    if (!dogrulama.ok) {
      is.kanit = kanit || null;
      is.hata = dogrulama.hata;
      this._gecir(is, IS_DURUM.BELIRSIZ,
        `kanıt yetersiz (${dogrulama.hata}) — tekrar denenmez, uzlaştırma gerekir`);
      return { ok: false, belirsiz: true, is, mesaj: dogrulama.hata };
    }
    is.kanit = kanit;
    is.hata = null;
    is.kiralayan = null;
    this._gecir(is, IS_DURUM.TAMAM, not || "kanıt doğrulandı");
    return { ok: true, is, caprazDogrulama: dogrulama.caprazDogrulama };
  }

  // Hata: yeniden denenebilir mi, yoksa kalici mi? Para etkileyen islerde
  // "bilmiyorum" cevabi YENIDEN DENEME degil, BELIRSIZ'dir.
  hataVer(id, { sebep, kalici = false, belirsiz = false } = {}) {
    const is = this.isler.get(id);
    if (!is) return { ok: false, mesaj: "İş bulunamadı" };
    is.hata = String(sebep || "bilinmeyen hata");
    is.kiralayan = null;
    const durum = belirsiz ? IS_DURUM.BELIRSIZ
      : (kalici || is.deneme >= 3 ? IS_DURUM.KALICI_HATA : IS_DURUM.YENIDEN_DENENEBILIR);
    this._gecir(is, durum, is.hata);
    return { ok: true, is };
  }

  kullaniciBekle(id, neden) {
    const is = this.isler.get(id);
    if (!is) return { ok: false, mesaj: "İş bulunamadı" };
    is.kiralayan = null;
    this._gecir(is, IS_DURUM.KULLANICI_BEKLIYOR, neden);
    return { ok: true, is };
  }

  // Uzlastirma listesi: belirsiz kalan isler. Bunlar OTOMATIK TEKRARLANMAZ;
  // once dis sistemde (Amazon/eBay) ne oldugu okunur.
  uzlastirmaBekleyenler() { return this.liste({ durum: IS_DURUM.BELIRSIZ }); }
}
