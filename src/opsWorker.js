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

// Faz ayari: kullanici acmadikca Faz 1 sinirinda kalir.
export class FazAyari {
  constructor(baslangic = FAZ1_UST_SINIR) { this.ustSinir = baslangic; }
  ac(seviye) {
    const sayi = Number(seviye);
    if (!Number.isInteger(sayi) || sayi < 0 || sayi > 4) throw new Error("Geçersiz risk seviyesi (0-4)");
    this.ustSinir = sayi;
    return this.ustSinir;
  }
  izinliMi(risk) { return Number(risk) <= this.ustSinir; }
  durum() {
    return {
      ustSinir: this.ustSinir,
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
  constructor({ jobs, controller, orchestrator, store, config, faz = null, onayIste = null }) {
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
      && this.faz.izinliMi(i.risk)) || null;
  }

  // Faz kapisi kapaliysa is yurutulmez; neden yurutulmedigi kayda gecer.
  async yurut(isId, { sahip = "worker-1" } = {}) {
    const is = this.jobs.bul(isId);
    if (!is) return { ok: false, mesaj: "İş bulunamadı" };
    if (!this.faz.izinliMi(is.risk)) {
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
      return bitis.ok
        ? { ok: true, is: bitis.is, caprazDogrulama: bitis.caprazDogrulama }
        : { ok: false, belirsiz: true, mesaj: bitis.mesaj };
    } catch (hata) {
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
    if (geriAlinamaz) {
      const onay = await this._onayGerekli(is, geriAlinamaz);
      if (!onay) {
        this.jobs.kullaniciBekle(is.id, `Onay bekleniyor: ${geriAlinamaz}`);
        // "beklemede" bayragi sart: yoksa yurut() bunu siradan hata sanip
        // "yeniden denenebilir"e cekiyor ve onaysiz is tekrar kuyruga giriyor.
        return { ok: false, beklemede: true, sebep: `Onay verilmedi: ${geriAlinamaz}` };
      }
    }
    // Faz 2+ doldurulacak: ekran adimlari. Su an kanit uretilmedigi icin
    // is BELIRSIZ olur — bu bilincli: kanitsiz "tamam" demek yasak.
    return { ok: false, belirsiz: true,
      sebep: "Ekran adımları henüz bağlanmadı; kanıt üretilmediği için iş tamam sayılmadı." };
  }
}
