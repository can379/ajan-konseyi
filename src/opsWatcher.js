// Canli izleyici — CanSellerAI SENSOR, uzak masaustu EL.
//
// Kullanici istegi: "cansellerai'yi sunucu ile beraber bu yapay zekaya bagla;
// sunucu icinde anlik verileri gorebilir ve anlik mudahale edebilir. Mesela
// iade oldugu an o iadeyi gorur ve hemen iade islemini gerceklestirir."
//
// Tasarim: panel verisi duzenli yoklanir, YENI kayitlar tespit edilir ve
// ise donusturulur. Is kuyrugu zaten idempotens; ayni iade ikinci kez ise
// donusmez. Yurutme kismi faz kapisina baglidir — kapali is turleri yalniz
// kuyruga girer, yurutulmez.
//
// NEDEN "gordugu an hemen" DEGIL de kisa bir BEKLEME PENCERESI var:
// bir iade/dava kaydi olustugu anda alan bilgileri henuz eksik olabiliyor
// (eBay tarafi birkac saniye-dakika icinde dolduruyor) ve kayit ayni tur
// icinde kapanabiliyor (alici vazgeciyor). Yarim veriyle islem baslatmak,
// bu projede en pahali hata sinifi olan CIFT/YANLIS islemi doguruyor.
// Bu yuzden: gorur gormez KUYRUGA alinir, ama yurutme icin kaydin
// olgunlasma suresi beklenir.

const VARSAYILAN = Object.freeze({
  yoklamaMs: 60_000,       // panel yoklamasi: dakikada bir
  olgunlasmaMs: 120_000,   // kayit gorulduken sonra yurutmeye kadar bekleme
  maxKayit: 200,           // tur basina islenecek en fazla kayit
});

// Panel yanitindan kayitlari tek bicime cevirir. Farkli uclar farkli alan
// adlari kullaniyor; burada tek sozluge iniyor.
export function kayitlariCikar(tur, veri) {
  const liste = Array.isArray(veri) ? veri : (veri?.items || veri?.rows || []);
  return liste.map((k) => {
    if (tur === "returns") {
      return {
        isTuru: "amazon_iade",
        varlikId: String(k.return_id || k.returnId || k.id || ""),
        acik: k.acik !== false,
        ozet: `${k.urunAdi || k.item_title || "ürün"} · ${k.sebepAdi || k.reason || "sebep yok"}`
          + (k.kalanGun != null ? ` · ${k.kalanGun} gün kaldı` : ""),
        onem: (k.kalanGun != null && k.kalanGun <= 2) ? "yuksek" : "orta",
        ham: { ebayOrderId: k.order_id || k.ebay_order_id || null, amazonOrderId: k.amazonOrderId || null },
      };
    }
    if (tur === "cases") {
      return {
        isTuru: "ebay_dava",
        varlikId: String(k.case_id || k.inquiry_id || k.id || ""),
        acik: !/closed|kapali/i.test(String(k.status || k.durum || "")),
        ozet: `${k.type || k.tur || "talep"} · ${k.item_title || k.urunAdi || ""}`,
        onem: "yuksek",
        ham: { ebayOrderId: k.order_id || null, aliciId: k.buyer || null },
      };
    }
    if (tur === "orders") {
      return {
        isTuru: "amazon_siparis",
        varlikId: String(k.ebay_order_id || k.ref || k.id || ""),
        acik: true,
        ozet: `${k.item_title || k.title || "sipariş"} · ${k.detail || k.issue_note || ""}`,
        onem: "orta",
        ham: { asin: k.asin || null },
      };
    }
    return null;
  }).filter((k) => k && k.varlikId);
}

export class OpsWatcher {
  constructor({ canseller, jobs, store, faz = null, ayar = {} }) {
    this.canseller = canseller;
    this.jobs = jobs;
    this.store = store;
    this.faz = faz;
    this.ayar = { ...VARSAYILAN, ...ayar };
    this.calisiyor = false;
    this.zamanlayici = null;
    this.gorulen = new Map();   // anahtar -> ilk gorulme zamani (olgunlasma icin)
    this.sonYoklama = null;
    this.sonHata = null;
    this.hesap = null;          // hangi magazanin verisi izleniyor
  }

  durum() {
    return {
      calisiyor: this.calisiyor,
      hesap: this.hesap,
      sonYoklama: this.sonYoklama,
      sonHata: this.sonHata,
      izlenen: this.gorulen.size,
      ayar: this.ayar,
    };
  }

  baslat(hesap) {
    if (this.calisiyor) return { ok: false, mesaj: "İzleyici zaten çalışıyor" };
    if (!this.canseller?.connected?.()) return { ok: false, mesaj: "CanSellerAI bağlantısı yok" };
    this.hesap = hesap || null;
    this.calisiyor = true;
    this.zamanlayici = setInterval(() => this.yokla().catch(() => {}), this.ayar.yoklamaMs);
    this.yokla().catch(() => {});
    return { ok: true };
  }

  durdur() {
    this.calisiyor = false;
    if (this.zamanlayici) clearInterval(this.zamanlayici);
    this.zamanlayici = null;
    return { ok: true };
  }

  // Bir tur yoklama: panelden oku, YENI kayitlari ise cevir.
  async yokla() {
    if (!this.canseller?.connected?.()) { this.sonHata = "CanSellerAI oturumu düştü"; return { ok: false }; }
    let genel;
    try { genel = await this.canseller.overview(); }
    catch (hata) { this.sonHata = String(hata.message || hata); return { ok: false, hata: this.sonHata }; }
    this.sonYoklama = new Date().toISOString();
    this.sonHata = null;

    const kayitlar = [
      ...kayitlariCikar("returns", genel.returns),
      ...kayitlariCikar("cases", genel.cases),
      ...(genel.work?.groups || []).flatMap((g) => g.key === "orders" ? kayitlariCikar("orders", g.items) : []),
    ].filter((k) => k.acik).slice(0, this.ayar.maxKayit);

    const yeni = [];
    const simdi = Date.now();
    for (const kayit of kayitlar) {
      const anahtar = `${kayit.isTuru}:${this.hesap || "?"}:${kayit.varlikId}`;
      if (!this.gorulen.has(anahtar)) {
        this.gorulen.set(anahtar, simdi);
        // Gorur gormez KUYRUGA: kaydi kacirmamak icin. Yurutme olgunlasma
        // suresi dolunca yapilir (asagidaki olgunMu).
        const sonuc = this.jobs.ekle({
          isTuru: kayit.isTuru, hesap: this.hesap || "?", varlikId: kayit.varlikId,
          risk: kayit.isTuru === "ebay_dava" ? 4 : 3,
          veri: { ozet: kayit.ozet, onem: kayit.onem, kaynak: "canlı izleyici", ham: kayit.ham },
        });
        if (sonuc.ok) yeni.push({ ...kayit, isId: sonuc.is.id });
      }
    }
    // Kapanmis kayitlarin izini birak (bellekte sonsuz birikmesin).
    const acikAnahtarlar = new Set(kayitlar.map((k) => `${k.isTuru}:${this.hesap || "?"}:${k.varlikId}`));
    for (const anahtar of [...this.gorulen.keys()]) if (!acikAnahtarlar.has(anahtar)) this.gorulen.delete(anahtar);

    if (yeni.length && this.store) {
      this.store.emit("event", { type: "ops_yeni_is", adet: yeni.length, hesap: this.hesap });
    }
    return { ok: true, toplam: kayitlar.length, yeni: yeni.length, kayitlar: yeni };
  }

  // Kayit yurutmeye hazir mi? Olgunlasma suresi dolmali — yarim veriyle
  // islem baslatmak bu projedeki en pahali hata sinifi.
  olgunMu(isTuru, varlikId) {
    const anahtar = `${isTuru}:${this.hesap || "?"}:${varlikId}`;
    const ilk = this.gorulen.get(anahtar);
    if (!ilk) return true;   // izlenmeyen kayit (elle acilmis is) beklemez
    return Date.now() - ilk >= this.ayar.olgunlasmaMs;
  }
}
