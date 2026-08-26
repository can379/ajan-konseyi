// CanSellerAI baglayicisi — FAZ 1: YALNIZ OKUMA.
//
// Ajan Konseyi'nin "Operasyon Merkezi" ekrani canli sistemden (uzak sunucu,
// tek giris adresi https://cansellerai.com) iadeleri, davalari, siparis
// mudahalelerini ve oturum sagligini OKUR. Bu dosya hicbir yazma islemi
// yapmaz: yalniz GET cagrilari ve hesap secimi icin gereken switch cagrisi.
//
// GUVENLIK SOZLESMESI (bu dosyanin var olus sebebi):
// - Parola DISKE YAZILMAZ. Kullanici arayuzden girer, buradan hub'a gecer,
//   bellekte bile tutulmaz; geriye yalniz HttpOnly oturum cerezi kalir.
// - Cerez SUNUCU KATMANINDA kalir. Konsey uyelerine (Claude/Codex/
//   Antigravity) asla gecmez; uyeler yalniz temizlenmis veri gorur.
// - Uretimde hub'a sureli ve iptal edilebilir bir SERVIS ANAHTARI eklenecek;
//   ayni baglayici onu da kabul eder (setServiceKey) ve o zaman parola/cerez
//   yoluna hic girilmez.
// - Izin verilen yol listesi (READ_ALLOWLIST) disina cikilamaz; yazma
//   yontemleri (POST/PUT/DELETE) bu sinifta hic uygulanmamistir.

import fs from "node:fs";
import path from "node:path";

const VARSAYILAN_TABAN = "https://cansellerai.com";

// Faz 1'de dokunulabilecek TEK okuma kumesi. Yeni uc eklemek bilincli bir
// karar olmali; bu yuzden desen degil, tam yol listesi tutuluyor.
export const READ_ALLOWLIST = Object.freeze([
  "/api/hub/accounts",
  "/api/ui/summary",
  "/api/ui/returns",
  "/api/ui/cases",
  "/api/ui/orders",
  "/api/ui/work-center",
  "/api/ui/jobs",
  "/api/ui/takip-sagligi",
  "/api/ui/amazon-connections",
]);

// Uyelere gidecek veriden cikarilacak alanlar: alici kimligi, adres, kisisel
// iletisim. Operasyon karari icin gerekmez; sizmasi da istenmez.
const GIZLENECEK = /^(buyer|alici|address|adres|email|eposta|phone|telefon|postal|zip|street|recipient|name_line)/i;

export function temizleKayit(kayit, derinlik = 0) {
  if (kayit === null || typeof kayit !== "object" || derinlik > 6) return kayit;
  if (Array.isArray(kayit)) return kayit.map((x) => temizleKayit(x, derinlik + 1));
  const cikti = {};
  for (const [anahtar, deger] of Object.entries(kayit)) {
    if (GIZLENECEK.test(anahtar)) { cikti[anahtar] = "[gizlendi]"; continue; }
    cikti[anahtar] = temizleKayit(deger, derinlik + 1);
  }
  return cikti;
}

export class CanSellerAI {
  constructor({ baseUrl = VARSAYILAN_TABAN, fetchImpl = fetch, dataRoot = null } = {}) {
    this.dataRoot = dataRoot;
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.cookie = null;        // HttpOnly hub oturumu — yalniz bellekte
    this.serviceKey = null;    // ileride: sureli, iptal edilebilir servis anahtari
    this.activeAccountId = null;
    this.lastError = null;
  }

  // Uretim yolu: parola hic gormeden calis.
  setServiceKey(key) { this.serviceKey = key ? String(key) : null; }

  connected() { return Boolean(this.serviceKey || this.cookie); }

  // Durum bilgisi arayuze gider; cerez/anahtarin KENDISI asla gitmez.
  status() {
    return {
      baseUrl: this.baseUrl,
      connected: this.connected(),
      mode: this.serviceKey ? "servis-anahtari" : (this.cookie ? "oturum" : "bagli-degil"),
      activeAccountId: this.activeAccountId,
      lastError: this.lastError,
    };
  }

  _headers(extra = {}) {
    const h = { Accept: "application/json", ...extra };
    if (this.serviceKey) h.Authorization = `Bearer ${this.serviceKey}`;
    else if (this.cookie) h.Cookie = this.cookie;
    return h;
  }

  // Kullanici parolasini KENDI girer; buradan hub'a gecer ve bir daha
  // tutulmaz. Geriye yalniz oturum cerezi kalir.
  async login(kullanici, parola) {
    const yanit = await this.fetchImpl(`${this.baseUrl}/api/hub/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ login: String(kullanici || ""), password: String(parola || "") }),
      redirect: "manual",
    });
    const kurabiye = (yanit.headers.getSetCookie?.() || [])
      .map((satir) => String(satir).split(";")[0])
      .filter((satir) => /^cansellerai_hub=/.test(satir));
    if (!yanit.ok || !kurabiye.length) {
      this.lastError = `Giriş başarısız (${yanit.status})`;
      throw new Error(this.lastError);
    }
    this.cookie = kurabiye.join("; ");
    this.lastError = null;
    this.oturumuKaydet();
    return { ok: true };
  }

  cikis() { this.oturumuSil(); this.activeAccountId = null; }

  // ---- OTURUM KALICILIGI ----
  // Kullanici: "cansellerai sitesinde surekli var olsun yazilim". Uygulama
  // yeniden baslayinca oturumun kaybolmamasi gerekir.
  //
  // Cerez diske 0600 izniyle yazilir (yalniz kullanicinin kendisi okur) ve
  // HICBIR api ucundan geri verilmez. PAROLA YAZILMAZ — bu yuzden oturum
  // duserse kendiliginden yeniden giris YAPILAMAZ; kullaniciya bildirilir.
  // Bu bilincli bir tercih: parolayi saklamak, calinabilecek bir sey
  // saklamaktir; dusen oturumu bir kez elle acmak bundan ucuzdur.
  _oturumDosyasi() { return path.join(this.dataRoot || "", "canseller-oturum.json"); }

  oturumuKaydet() {
    if (!this.dataRoot || !this.cookie) return false;
    try {
      fs.mkdirSync(this.dataRoot, { recursive: true });
      fs.writeFileSync(this._oturumDosyasi(),
        JSON.stringify({ cookie: this.cookie, at: new Date().toISOString(), baseUrl: this.baseUrl }),
        { mode: 0o600 });
      return true;
    } catch { return false; }
  }

  oturumuYukle() {
    if (!this.dataRoot) return false;
    try {
      const kayit = JSON.parse(fs.readFileSync(this._oturumDosyasi(), "utf8"));
      if (!kayit?.cookie) return false;
      this.cookie = kayit.cookie;
      this.oturumTarihi = kayit.at || null;
      return true;
    } catch { return false; }
  }

  oturumuSil() {
    try { fs.unlinkSync(this._oturumDosyasi()); } catch {}
    this.cookie = null;
  }

  async _get(yol) {
    if (!READ_ALLOWLIST.includes(yol)) throw new Error(`İzin verilmeyen yol: ${yol}`);
    if (!this.connected()) throw new Error("CanSellerAI oturumu yok; önce bağlanın.");
    const yanit = await this.fetchImpl(`${this.baseUrl}${yol}`, { headers: this._headers() });
    if (yanit.status === 401 || yanit.status === 403) {
      this.lastError = "Oturum düştü veya yetki yok";
      throw new Error(this.lastError);
    }
    if (!yanit.ok) throw new Error(`${yol} okunamadı (${yanit.status})`);
    return yanit.json();
  }

  async accounts() { return this._get("/api/hub/accounts"); }

  // Hesap secimi teknik olarak POST'tur ama VERI DEGISTIRMEZ: yalniz oturumun
  // hangi magazaya baktigini belirler. Faz 1'de izin verilen tek POST budur.
  async switchAccount(hesapId) {
    if (this.serviceKey) { this.activeAccountId = hesapId; return { ok: true }; }
    if (!this.cookie) throw new Error("CanSellerAI oturumu yok.");
    const yanit = await this.fetchImpl(`${this.baseUrl}/api/hub/accounts/switch`, {
      method: "POST",
      headers: this._headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ id: hesapId }),
    });
    if (!yanit.ok) throw new Error(`Mağaza seçilemedi (${yanit.status})`);
    const yeni = (yanit.headers.getSetCookie?.() || [])
      .map((s) => String(s).split(";")[0]).filter((s) => /^cansellerai_hub=/.test(s));
    if (yeni.length) { this.cookie = yeni.join("; "); this.oturumuKaydet(); }
    this.activeAccountId = hesapId;
    return { ok: true };
  }

  // Operasyon merkezinin tek okuyusta ihtiyac duydugu her sey. Bir uc
  // duserse digerleri yine gelir (kismi gorunum, sessiz bosluk degil).
  async overview() {
    const parcalar = { returns: "/api/ui/returns", cases: "/api/ui/cases", work: "/api/ui/work-center" };
    const sonuc = { at: new Date().toISOString(), accountId: this.activeAccountId, hatalar: {} };
    await Promise.all(Object.entries(parcalar).map(async ([ad, yol]) => {
      try { sonuc[ad] = await this._get(yol); }
      catch (hata) { sonuc[ad] = null; sonuc.hatalar[ad] = String(hata.message || hata); }
    }));
    return sonuc;
  }
}
