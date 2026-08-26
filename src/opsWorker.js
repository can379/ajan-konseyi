// Is yurutucu — kuyruktaki isi uzak masaustunde yapan katman.
//
// FAZ KAPISI BURADA: yurutucu yalniz izin verilen risk seviyesine kadar is
// alir. Kullanici kapiyi acana kadar (FAZ_AYARI) risk 2+ isler yalniz
// HAZIRLANIR — yurutulmez. Kapi tek yerden yonetilir ki "acik mi kapali mi"
// sorusu koda dagilmasin.
//
// Yurutmenin degismez cercevesi (konsey karari):
//   1) Isi KIRALA (ayni is iki yerde calismasin)
//   2) On kosullari CanSellerAI kaydiyla dogrula — ekrandan okunan tek basina
//      gercek degildir
//   3) Adimlari uygula: her adimdan sonra ekrani yeniden oku ve DOGRULA
//   4) Kanit topla; kanit sozlesmesini gecmezse is BELIRSIZ olur
//   5) Belirsizde TEKRAR YOK — uzlastirmaya gider
//
// Risk 3-4 adimlarda (Place Order, Confirm your return, dava gonderimi)
// kullanici onayi istenir; onay gelmezse is kullanici bekliyor durumunda
// kalir ve hicbir sey yapilmaz.

import { IS_DURUM, kanitDogrula } from "./opsJobs.js";
import { OYUN_KITABI, isYonergesi, RISK, FAZ1_UST_SINIR } from "./opsPlaybook.js";
import { muhurKontrol, mesajFiltresi } from "./opsGuvenlik.js";

// Faz ayari: kullanici acmadikca Faz 1 sinirinda kalir.
export class FazAyari {
  constructor(baslangic = FAZ1_UST_SINIR, { politika = null } = {}) {
    this.ustSinir = baslangic;
    // policy_verified (konsey karari): bir is turunun politika metni bir
    // INSAN tarafindan okunup kayda gecmeden o turun kapisi acilamaz.
    // Kaynak uydurmak yerine dogrulamayi kodda kisita cevirir.
    this.politika = politika;
    // IS TURU BAZINDA acma: genel siniri yukseltmeden TEK bir is turunu
    // acabilmek gerekir. Kullanici "mesaj ac" dedi — siparis/iade/dava
    // kapali kalmali. Genel siniri yukseltmek hepsini birden acardi.
    this.acikTurler = new Set();
  }
  ac(seviye) {
    const sayi = Number(seviye);
    if (!Number.isInteger(sayi) || sayi < 0 || sayi > 4) throw new Error("Geçersiz risk seviyesi (0-4)");
    this.ustSinir = sayi;
    return this.ustSinir;
  }
  turAc(isTuru) {
    if (this.politika && !this.politika.dogrulandiMi(isTuru)) {
      throw new Error(`"${isTuru}" için politika doğrulaması yok — kapı açılamaz. Önce belgeyi okuyup kaydedin.`);
    }
    this.acikTurler.add(String(isTuru));
    return [...this.acikTurler];
  }
  turKapat(isTuru) { this.acikTurler.delete(String(isTuru)); return [...this.acikTurler]; }
  izinliMi(risk, isTuru = null) {
    if (isTuru && this.acikTurler.has(String(isTuru))) return true;
    return Number(risk) <= this.ustSinir;
  }
  durum() {
    return {
      ustSinir: this.ustSinir,
      acikTurler: [...this.acikTurler],
      aciklama: this.ustSinir <= RISK.TASLAK
        ? "Faz 1: yalnız gözlem ve taslak. Sipariş, iade ve mesaj işlemleri kapalı."
        : this.ustSinir === RISK.POLITIKA
          ? "Faz 2: politikaya uyan işler otomatik (takip kodu, ücretsiz etiket). Para hareketi kapalı."
          : this.ustSinir === RISK.ONAY
            ? "Faz 3: sipariş ve iade yürütülür; geri alınamaz adımlarda onay istenir."
            : "Faz 4: para hareketi dahil tüm işler açık — her işlemde onay istenir.",
    };
  }
}

export class OpsWorker {
  constructor({ jobs, controller, orchestrator, store, config, faz = null, onayIste = null,
                killSwitch = null, kesici = null, ekranOku = null }) {
    this.killSwitch = killSwitch;
    this.kesici = kesici;
    // ekranOku(is) -> {pencereBasligi, metin, dugme}. Baglam muhru bunu
    // kullanir; verilmezse muhur DOGRULANAMAZ sayilir ve tiklama yapilmaz.
    this.ekranOku = ekranOku;
    this.jobs = jobs;
    this.controller = controller;
    this.orch = orchestrator;
    this.store = store;
    this.config = config;
    this.faz = faz || new FazAyari();
    // onayIste(is, adim) -> Promise<boolean>. Verilmezse geri alinamaz adim
    // ONAYSIZ SAYILIR (guvenli varsayilan).
    this.onayIste = onayIste;
    this.aktif = null;
  }

  // Kuyruktan yurutulebilecek ilk isi sec: faz sinirina uyan, kiralanabilir,
  // beklemede olmayan.
  siradakiIs() {
    return this.jobs.liste().find((i) =>
      [IS_DURUM.KUYRUKTA, IS_DURUM.YENIDEN_DENENEBILIR].includes(i.durum)
      && this.faz.izinliMi(i.risk, i.isTuru)) || null;
  }

  // Faz kapisi kapaliysa is yurutulmez; neden yurutulmedigi kayda gecer.
  async yurut(isId, { sahip = "worker-1" } = {}) {
    const is = this.jobs.bul(isId);
    if (!is) return { ok: false, mesaj: "İş bulunamadı" };
    // KILL-SWITCH: dosya varsa hicbir is yurutulmez. Arayuz acilmasa bile
    // kullanici tek komutla durdurabilsin diye dosya tabanli.
    if (this.killSwitch?.aktifMi()) {
      this.jobs.kullaniciBekle(is.id, `Acil durdurma etkin: ${this.killSwitch.sebep()}`);
      return { ok: false, durduruldu: true, mesaj: `Acil durdurma etkin: ${this.killSwitch.sebep()}` };
    }
    // DEVRE KESICI: bu magazada ust uste hata varsa yapisal bir sorun var;
    // denemeye devam etmek ayni hatayi cogaltir. Yalniz O magaza kapanir.
    if (this.kesici?.kapaliMi(is.hesap)) {
      const d = this.kesici.durum(is.hesap);
      this.jobs.kullaniciBekle(is.id,
        `${d.magaza} devresi kapalı (${d.hata} hata: ${d.sonSebep || "?"}) — ${Math.ceil(d.kalanMs / 60000)} dk sonra yeniden denenir`);
      return { ok: false, kesici: true, mesaj: `${d.magaza} devresi kapalı` };
    }
    if (!this.faz.izinliMi(is.risk, is.isTuru)) {
      this.jobs.kullaniciBekle(is.id,
        `Risk ${is.risk} iş, açık faz sınırının (${this.faz.ustSinir}) üstünde — yürütülmedi`);
      return { ok: false, kapali: true, mesaj: this.faz.durum().aciklama };
    }
    const kira = this.jobs.kirala(is.id, sahip);
    if (!kira.ok) return { ok: false, mesaj: kira.mesaj };

    const oyun = OYUN_KITABI[is.isTuru];
    if (!oyun) {
      this.jobs.hataVer(is.id, { sebep: `Tanımsız iş türü: ${is.isTuru}`, kalici: true });
      return { ok: false, mesaj: "Tanımsız iş türü" };
    }
    this.aktif = { isId: is.id, hedef: is.hesap };
    try {
      // 2) On kosullar: CanSellerAI kaydiyla dogrulanmadan ilerlenmez.
      const eksik = (is.veri?.onKosulEksik || []);
      if (eksik.length) {
        this.jobs.kullaniciBekle(is.id, `Ön koşul doğrulanmadı: ${eksik.join(", ")}`);
        return { ok: false, mesaj: "Ön koşullar eksik" };
      }
      // 3-4) Adimlar ve kanit: bu katman ADIMLARI uygular ama son sozu
      // kanit sozlesmesi soyler.
      const sonuc = await this._adimlariUygula(is, oyun);
      if (sonuc.belirsiz) {
        this.jobs.hataVer(is.id, { sebep: sonuc.sebep || "sonuç okunamadı", belirsiz: true });
        return { ok: false, belirsiz: true, mesaj: sonuc.sebep };
      }
      if (sonuc.beklemede) {
        // Zaten "kullanici bekliyor" durumuna alindi; hata sayilmaz.
        return { ok: false, beklemede: true, mesaj: sonuc.sebep };
      }
      if (!sonuc.ok) {
        this.jobs.hataVer(is.id, { sebep: sonuc.sebep || "adım başarısız" });
        return { ok: false, mesaj: sonuc.sebep };
      }
      const bitis = this.jobs.bitir(is.id, { kanit: sonuc.kanit, not: sonuc.not });
      if (bitis.ok) this.kesici?.basari(is.hesap);
      else this.kesici?.hata(is.hesap, bitis.mesaj || "kanıt doğrulanmadı");
      return bitis.ok
        ? { ok: true, is: bitis.is, caprazDogrulama: bitis.caprazDogrulama }
        : { ok: false, belirsiz: true, mesaj: bitis.mesaj };
    } catch (hata) {
      this.kesici?.hata(is.hesap, String(hata.message || hata));
      this.jobs.hataVer(is.id, { sebep: String(hata.message || hata) });
      return { ok: false, mesaj: String(hata.message || hata) };
    } finally {
      this.aktif = null;
    }
  }

  // Geri alinamaz adim: onay ZORUNLU. onayIste verilmemisse onaysiz sayilir.
  async _onayGerekli(is, adimAdi) {
    if (!this.onayIste) return false;
    try { return Boolean(await this.onayIste(is, adimAdi)); }
    catch { return false; }
  }

  // Muhru bas: ekrani yeniden oku, beklenenle karsilastir.
  // ekranOku verilmemisse muhur DOGRULANAMAZ — guvenli varsayilan "tiklama".
  async _muhurBas(is, adimAdi) {
    if (!this.ekranOku) {
      return { ok: false, mesaj: `Bağlam mührü basılamadı (ekran okunamıyor) — "${adimAdi}" yapılmadı.` };
    }
    let ekran;
    try { ekran = await this.ekranOku(is); }
    catch (hata) { return { ok: false, mesaj: `Ekran okunamadı: ${String(hata.message || hata)}` }; }
    return muhurKontrol({ magaza: is.hesap, varlikId: is.varlikId, dugme: is.veri?.beklenenDugme || "" }, ekran || {});
  }

  // Adim uygulama iskeleti. Gercek ekran islemleri Faz 2+ ile doldurulacak;
  // su an cerceve ve KAPILAR yerinde: geri alinamaz adimda onay sorulur,
  // sonuc dogrulanamazsa BELIRSIZ donulur.
  async _adimlariUygula(is, oyun) {
    const geriAlinamaz = {
      amazon_siparis: "'Place your order' — sipariş kesinleşir",
      amazon_iade: "'Confirm your return' — Amazon'da gerçek iade oluşur",
      ebay_dava: "Dava yanıtı gönderimi",
      stok_yok_mesaji: "Alıcıya mesaj gönderimi",
    }[is.isTuru];
    // MESAJ FILTRESI: gonderim ONCESI. Ajan iyi niyetle "whatsapp'tan yazin"
    // ya da "5 yildiz verirseniz seviniriz" yazip magazayi riske atmasin.
    if (is.isTuru === "ebay_mesaj" || is.isTuru === "stok_yok_mesaji") {
      const taslak = is.veri?.mesajTaslagi || is.veri?.taslak || "";
      if (taslak) {
        const filtre = mesajFiltresi(taslak);
        if (!filtre.ok) {
          this.jobs.kullaniciBekle(is.id, filtre.mesaj);
          return { ok: false, beklemede: true, sebep: filtre.mesaj };
        }
      }
    }
    if (geriAlinamaz) {
      const onay = await this._onayGerekli(is, geriAlinamaz);
      if (!onay) {
        this.jobs.kullaniciBekle(is.id, `Onay bekleniyor: ${geriAlinamaz}`);
        // "beklemede" bayragi sart: yoksa yurut() bunu siradan hata sanip
        // "yeniden denenebilir"e cekiyor ve onaysiz is tekrar kuyruga giriyor.
        return { ok: false, beklemede: true, sebep: `Onay verilmedi: ${geriAlinamaz}` };
      }
      // BAGLAM MUHRU — SIRA ONEMLI: onaydan SONRA, tiklamadan HEMEN ONCE.
      // Onay ile tiklama arasinda gecen surede odak baska pencereye kayabilir;
      // bugunku kimlik dogrulamasi yalniz oturum acilisinda yapiliyordu ve bu
      // araligi hic gormuyordu. Muhur tutmazsa TIKLAMA YAPILMAZ.
      const muhur = await this._muhurBas(is, geriAlinamaz);
      if (!muhur.ok) {
        this.kesici?.hata(is.hesap, muhur.mesaj);
        return { ok: false, belirsiz: true, sebep: muhur.mesaj };
      }
    }
    // Faz 2+ doldurulacak: ekran adimlari. Su an kanit uretilmedigi icin
    // is BELIRSIZ olur — bu bilincli: kanitsiz "tamam" demek yasak.
    return { ok: false, belirsiz: true,
      sebep: "Ekran adımları henüz bağlanmadı; kanıt üretilmediği için iş tamam sayılmadı." };
  }
}
