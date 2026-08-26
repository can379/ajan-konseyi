// Uzak masaustu denetleyicisi — FAZ 1: YALNIZ GOZLEM.
//
// Amac: ajan, Microsoft "Windows App" icindeki KAYITLI cihazlara (magaza
// sunuculari) sirayla baglanip uzak masaustunu EKRANDAN gorsun; iade, dava,
// siparis ve hesap kayitlarini yalniz OKUSUN; sonra baglantiyi kapatip
// siradaki cihaza gecsin.
//
// TEMEL TASARIM KARARI — piksel tahmini ANA YONTEM DEGILDIR:
//   1) Erisilebilirlik agaci (macOS AX / Windows UI Automation)  <-- oncelik
//   2) OCR ile hedef metin dogrulamasi
//   3) Gorsel model
//   4) Sabit koordinat  <-- yalniz son care
// Canli olcum: Windows App'in AX agaci kayitli cihazlari ADLARIYLA ve
// KONUMLARIYLA veriyor ("[AXGroup] ANNE @460,141 176x63"). Bu yuzden hedef
// adla bulunur ve kartin KENDI merkezine tiklanir; koordinat tahmini yok.
// Yanlis sunucuya baglanma sorununun kaynagi tam olarak buydu.
//
// GUVENLIK SINIRLARI (Faz 1):
// - Yazma yok: yalniz baglanti acma, gezinme, goruntuleme. Iade baslatma,
//   siparis gecme, mesaj gonderme, dava yanitlama KAPALI (EYLEM_IZNI).
// - Parola modele verilmez. Ajan yalniz KAYITLI CIHAZ ADINI secebilir;
//   kimlik bilgileri Windows App'in kendi guvenli profilinde kalir.
// - Belirsiz eslesme = DUR. Ad birebir eslesmiyorsa veya birden fazla aday
//   varsa tiklama yapilmaz, is durur.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Faz 1'de izin verilen eylemler. Liste bilerek dardir; yazma eylemleri
// (metin gonderme, form doldurma, onaylama) burada YOKTUR.
export const GOZLEM_EYLEMLERI = Object.freeze([
  "listele", "cihaz_sec", "baglan", "kimlik_dogrula", "ekran_al", "bekle", "kapat",
]);

// Bir adimdan digerine gecerken beklenen durumlar.
export const DURUMLAR = Object.freeze([
  "hazir", "listeleniyor", "baglaniyor", "dogrulaniyor", "gozlemde", "kapaniyor", "bitti", "hata",
]);

const AX_SWIFT = `import Foundation
import ApplicationServices
import AppKit

// Windows App'in erisilebilirlik agacindan KAYITLI CIHAZLARI okur.
// Cikti JSON: {"ok":true,"devices":[{"name":"ANNE","x":548,"y":172}],"sidebar":[...]}
guard AXIsProcessTrusted() else {
  print("{\\"ok\\":false,\\"error\\":\\"izin-yok\\"}"); exit(0)
}
let hedefUygulama = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Windows App"
guard let uygulama = NSWorkspace.shared.runningApplications.first(where: { $0.localizedName == hedefUygulama }) else {
  print("{\\"ok\\":false,\\"error\\":\\"uygulama-kapali\\"}"); exit(0)
}
let ax = AXUIElementCreateApplication(uygulama.processIdentifier)

func oz(_ el: AXUIElement, _ ad: String) -> CFTypeRef? {
  var deger: CFTypeRef?
  return AXUIElementCopyAttributeValue(el, ad as CFString, &deger) == .success ? deger : nil
}
func kutu(_ el: AXUIElement) -> (CGPoint, CGSize)? {
  guard let p = oz(el, kAXPositionAttribute), let s = oz(el, kAXSizeAttribute) else { return nil }
  var nokta = CGPoint.zero; var boyut = CGSize.zero
  AXValueGetValue(p as! AXValue, .cgPoint, &nokta)
  AXValueGetValue(s as! AXValue, .cgSize, &boyut)
  return (nokta, boyut)
}
func kacisla(_ s: String) -> String {
  // Satir sonlari ve sekmeler de kacislanmali: uyari pencerelerinin metni cok
  // satirli oluyor ve ham \\n JSON'u bozuyordu ("cikti bozuk" hatasi).
  var c = s.replacingOccurrences(of: "\\\\", with: "\\\\\\\\")
  c = c.replacingOccurrences(of: "\\"", with: "\\\\\\"")
  c = c.replacingOccurrences(of: "\\n", with: "\\\\n")
  c = c.replacingOccurrences(of: "\\r", with: "\\\\r")
  c = c.replacingOccurrences(of: "\\t", with: "\\\\t")
  return c
}

var cihazlar: [String] = []
var kenar: [String] = []
var dugmeler: [String] = []
var pencereMetni: [String] = []
var pencereler: [String] = []
var sayac = 0

// Kayitli cihaz listesi AXList "Saved Devices" altindaki AXGroup'lardir.
func gez(_ el: AXUIElement, _ derinlik: Int, _ listeIcinde: Bool) {
  if derinlik > 14 || sayac > 4000 { return }
  sayac += 1
  let rol = oz(el, kAXRoleAttribute) as? String ?? ""
  let baslik = (oz(el, kAXTitleAttribute) as? String) ?? ((oz(el, kAXDescriptionAttribute) as? String) ?? "")
  var buListe = listeIcinde
  // Acik OTURUM penceresinin basligi cihaz adidir ("[AXWindow] ANNE").
  // Kimligi modele sordurmadan KESIN dogrulamanin yolu budur.
  if rol == "AXWindow", !baslik.isEmpty {
    pencereler.append("{\\"title\\":\\"\\(kacisla(baslik))\\"}")
  }
  if rol == "AXList", baslik.localizedCaseInsensitiveContains("device") { buListe = true }
  if buListe, rol == "AXGroup", !baslik.isEmpty, let (nokta, boyut) = kutu(el) {
    let mx = Int(nokta.x + boyut.width / 2), my = Int(nokta.y + boyut.height / 2)
    cihazlar.append("{\\"name\\":\\"\\(kacisla(baslik))\\",\\"x\\":\\(mx),\\"y\\":\\(my),\\"w\\":\\(Int(boyut.width)),\\"h\\":\\(Int(boyut.height))}")
  }
  // Kenar cubugu dugmeleri (Favorites / Devices / Apps) — dogru sekmeye
  // gecmek icin gerekir; koordinat tahmini yapmamak adina onlari da oku.
  if rol == "AXButton" || rol == "AXCell", !baslik.isEmpty, let (nokta, boyut) = kutu(el),
     ["favorites", "devices", "apps"].contains(baslik.lowercased()) {
    let mx = Int(nokta.x + boyut.width / 2), my = Int(nokta.y + boyut.height / 2)
    kenar.append("{\\"name\\":\\"\\(kacisla(baslik))\\",\\"x\\":\\(mx),\\"y\\":\\(my)}")
  }
  // Onay/uyari pencereleri (sertifika, kimlik dogrulama) icin dugmeler ve
  // metin: koordinat TAHMIN ETMEDEN dogru dugmeye basabilmek gerekir.
  if rol == "AXButton", !baslik.isEmpty, let (nokta, boyut) = kutu(el) {
    let mx = Int(nokta.x + boyut.width / 2), my = Int(nokta.y + boyut.height / 2)
    dugmeler.append("{\\"name\\":\\"\\(kacisla(baslik))\\",\\"x\\":\\(mx),\\"y\\":\\(my)}")
  }
  if rol == "AXStaticText" || rol == "AXTextArea" {
    let metin = (oz(el, kAXValueAttribute) as? String) ?? baslik
    if !metin.isEmpty, metin.count < 600 { pencereMetni.append("\\"\\(kacisla(metin))\\"") }
  }
  if let cocuklar = oz(el, kAXChildrenAttribute) as? [AXUIElement] {
    for c in cocuklar { gez(c, derinlik + 1, buListe) }
  }
}
gez(ax, 0, false)
// Ayni ad birden fazla dugumden gelebilir (kart + ic etiket); tekille.
var gorulen = Set<String>()
let tekil = cihazlar.filter { satir in
  guard let r = satir.range(of: "\\"name\\":\\"") else { return false }
  let kalan = satir[r.upperBound...]
  guard let son = kalan.firstIndex(of: "\\"") else { return false }
  let ad = String(kalan[..<son])
  if gorulen.contains(ad) { return false }
  gorulen.insert(ad); return true
}
print("{\\"ok\\":true,\\"devices\\":[\\(tekil.joined(separator: ","))],\\"sidebar\\":[\\(kenar.joined(separator: ","))],\\"buttons\\":[\\(dugmeler.joined(separator: ","))],\\"texts\\":[\\(pencereMetni.joined(separator: ","))],\\"windows\\":[\\(pencereler.joined(separator: ","))]}")
`;

function run(cmd, args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).slice(0, 400)));
      else resolve(String(stdout));
    });
  });
}

// Ad karsilastirmasi: gorunmez bosluklar ve buyuk/kucuk harf disinda
// TOLERANS YOK. "ANNE" istenmisse "anne" kabul, "ANNE 2" veya "Anne-yedek"
// KABUL EDILMEZ — canli hata tam olarak boyle olusmustu.
export function adEslesir(istenen, aday) {
  const sadelestir = (x) => String(x || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("tr-TR");
  return sadelestir(istenen) === sadelestir(aday);
}

// Hedef secimi: birebir eslesen TEK aday sarttir.
export function hedefSec(cihazlar, istenen) {
  const adaylar = (cihazlar || []).filter((c) => adEslesir(istenen, c.name));
  if (adaylar.length === 1) return { ok: true, device: adaylar[0] };
  if (adaylar.length === 0) {
    const benzer = (cihazlar || []).filter((c) => String(c.name || "").toLocaleLowerCase("tr-TR")
      .includes(String(istenen || "").toLocaleLowerCase("tr-TR"))).map((c) => c.name);
    return { ok: false, reason: "bulunamadi",
      message: `"${istenen}" adında kayıtlı cihaz yok.${benzer.length ? ` Benzer adlar: ${benzer.join(", ")} — hiçbirine bağlanılmadı.` : ""}` };
  }
  return { ok: false, reason: "belirsiz",
    message: `"${istenen}" birden fazla karta uyuyor (${adaylar.length}); belirsizlikte bağlantı açılmaz.` };
}

// Sertifika/onay penceresi: metinden RDP sunucusunu (IP veya ad) cikar.
// Ornek: 'You are connecting to the RDP host "87.76.130.141". The certificate
// couldn't be verified back to a root certificate...'
export function sertifikaPenceresi(texts = [], buttons = []) {
  const metin = (texts || []).join(" ");
  if (!/certificate|sertifik/i.test(metin)) return null;
  const host = metin.match(/RDP host\s*[""']?([\w.:-]+)[""']?/i)?.[1]
    || metin.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/)?.[1]
    || null;
  const devam = (buttons || []).find((b) => /^(continue|devam|connect|bağlan)$/i.test(String(b.name || "").trim()));
  const iptal = (buttons || []).find((b) => /^(cancel|iptal)$/i.test(String(b.name || "").trim()));
  return { host, devam: devam || null, iptal: iptal || null, metin: metin.slice(0, 400) };
}

// Uyari penceresi: "Your session was disconnected ... Error code: 0x5" gibi.
// Kullanici bildirdi: "bu hatayi gorunce close basip tekrar acmayi denemeli".
export function oturumUyarisi(texts = [], buttons = []) {
  const metin = (texts || []).join(" ");
  if (!/disconnected|error code|bağlantı kesildi|hata kodu/i.test(metin)) return null;
  const kapat = (buttons || []).find((b) => /^(close|kapat|ok|tamam)$/i.test(String(b.name || "").trim()));
  return { metin: metin.slice(0, 300), kapat: kapat || null };
}

// Acik oturum penceresini bul: Windows App, RDP oturumunu cihaz ADIYLA
// baslikli ayri bir pencerede acar ("[AXWindow] ANNE"). Kimligi modele
// sordurmak yerine bunu okumak KESIN ve deterministiktir — canli olculdu:
// masaustu tam ekran Chrome oldugunda modelde hicbir kanit kalmiyordu.
export function oturumPenceresi(windows, hedef) {
  const adaylar = (windows || []).filter((w) => adEslesir(hedef, w.title));
  if (adaylar.length === 1) return { ok: true, pencere: adaylar[0] };
  if (adaylar.length > 1) return { ok: false, reason: "belirsiz", message: `"${hedef}" adıyla birden fazla pencere açık.` };
  const baskalari = (windows || []).map((w) => w.title).filter((t) => t && !/^windows app$/i.test(t));
  return { ok: false, reason: "yok",
    message: baskalari.length
      ? `"${hedef}" oturum penceresi yok; açık pencereler: ${baskalari.join(", ")}.`
      : `"${hedef}" oturum penceresi henüz açılmadı.` };
}

// Her sunucu icin kalici durum kaydi.
export function yeniDurum(hedef, beklenenKimlik = "") {
  return {
    target_device: hedef,
    expected_identity: beklenenKimlik || hedef,
    connection_state: "hazir",
    current_step: "",
    last_screenshot: null,
    findings: [],
    started_at: null,
    finished_at: null,
    error: null,
  };
}

export class RdpController {
  constructor(dataRoot, { computerBridge = null, appName = "Windows App" } = {}) {
    this.dataRoot = dataRoot;
    this.binDir = path.join(dataRoot, "bin");
    this.axBin = path.join(this.binDir, "axcihazlar");
    this.appName = appName;
    this.computer = computerBridge;   // ekran/tiklama koprusu
    this.durumlar = new Map();        // cihaz adi -> durum kaydi
  }

  durum(hedef) { return this.durumlar.get(hedef) || null; }
  tumDurumlar() { return [...this.durumlar.values()]; }

  _kaydet(hedef, yama) {
    const mevcut = this.durumlar.get(hedef) || yeniDurum(hedef);
    Object.assign(mevcut, yama);
    this.durumlar.set(hedef, mevcut);
    return mevcut;
  }

  // Yardimci ikili KAYNAK DEGISINCE yeniden derlenir. Yalniz "dosya var mi"
  // bakmak eski ikilinin takili kalmasina yol aciyordu: yeni alanlar (dialog
  // dugmeleri/metinleri) hic gelmiyor, sertifika penceresi gorunmuyordu.
  async ensureAxTool() {
    const imza = path.join(this.binDir, "axcihazlar.imza");
    const guncelImza = String(AX_SWIFT.length);
    if (fs.existsSync(this.axBin)) {
      let eski = "";
      try { eski = fs.readFileSync(imza, "utf8"); } catch {}
      if (eski === guncelImza) return this.axBin;
      try { fs.unlinkSync(this.axBin); } catch {}
    }
    fs.mkdirSync(this.binDir, { recursive: true });
    const src = path.join(this.binDir, "axcihazlar.swift");
    fs.writeFileSync(src, AX_SWIFT);
    await run("/usr/bin/swiftc", ["-O", "-o", this.axBin, src], 180_000);
    try { fs.writeFileSync(imza, guncelImza); } catch {}
    return this.axBin;
  }

  // 2. adim: kayitli cihazlari erisilebilirlik agacindan oku.
  async listele({ ham = false } = {}) {
    const bin = await this.ensureAxTool();
    let cikisMetni;
    try { cikisMetni = await run(bin, [this.appName]); }
    catch (error) { throw new Error(`Cihaz listesi okunamadı: ${String(error.message || error)}`); }
    let veri;
    try { veri = JSON.parse(String(cikisMetni).trim().split("\n").pop()); }
    catch { throw new Error("Cihaz listesi çözümlenemedi (erişilebilirlik çıktısı bozuk)."); }
    if (!veri.ok) {
      if (veri.error === "izin-yok") throw new Error('Erişilebilirlik izni yok: Sistem Ayarları > Gizlilik ve Güvenlik > Erişilebilirlik bölümünde "Ajan Konseyi"ni açın.');
      if (veri.error === "uygulama-kapali") throw new Error(`${this.appName} açık değil; önce uygulamayı açın.`);
      throw new Error(`Cihaz listesi alınamadı: ${veri.error}`);
    }
    const cikti = { devices: veri.devices || [], sidebar: veri.sidebar || [] };
    if (ham) { cikti.buttons = veri.buttons || []; cikti.texts = veri.texts || []; }
    cikti.windows = veri.windows || [];
    return cikti;
  }

  // CIHAZ LISTESINI HAZIRLA — baglanmadan once ekrani bilinen duruma getir.
  // Canli olculdu, uc ayri takilma durumu var:
  //   1) "Your session was disconnected" uyarisi acik  -> Close'a bas
  //   2) Eski bir OTURUM penceresi acik (baslik = cihaz adi) -> Cmd+W ile kapat
  //   3) Uygulamanin hic penceresi yok -> open -a ile geri getir
  // Hicbiri cozmezse cihaz listesi bos kalir ve hedef "bulunamadi" gorunur —
  // kullanici bunu "ANNE adinda kayitli cihaz yok" diye gordu.
  async cihazListesiniHazirla({ deneme = 20 } = {}) {
    const gunluk = [];
    for (let i = 0; i < deneme; i++) {
      let ham;
      try { ham = await this.listele({ ham: true }); }
      catch (hata) {
        // Uygulama kapaliysa ac ve yeniden dene.
        if (/açık değil/.test(String(hata.message))) {
          await this.computer.request({ action: "open_app", payload: { name: this.appName } });
          await this.computer.request({ action: "wait", payload: { seconds: 3 } });
          gunluk.push("uygulama açıldı");
          continue;
        }
        throw hata;
      }
      if ((ham.devices || []).length) return { ok: true, devices: ham.devices, gunluk };

      // 1) Uyari penceresi
      const uyari = oturumUyarisi(ham.texts, ham.buttons);
      if (uyari?.kapat) {
        await this.computer.request({ action: "click", payload: { x: uyari.kapat.x, y: uyari.kapat.y } });
        await this.computer.request({ action: "wait", payload: { seconds: 2 } });
        gunluk.push("bağlantı kesildi uyarısı kapatıldı");
        continue;
      }
      // 2) Acik oturum penceresi (baslik "Windows App" degilse oturumdur)
      const oturum = (ham.windows || []).find((w) => w.title && !/^windows app$/i.test(w.title));
      if (oturum) {
        await this.computer.request({ action: "key", payload: { key: "w", cmd: true } });
        await this.computer.request({ action: "wait", payload: { seconds: 2 } });
        gunluk.push(`"${oturum.title}" oturum penceresi kapatıldı`);
        continue;
      }
      // 3) Hic pencere yok: "open -a" YETMIYOR (canli olculdu, pencere
      // gelmiyor). macOS'ta kapatilmis pencereleri geri getiren dogru yol
      // "reopen"dir. Not: takilmis birden fazla oturum penceresi olabilir;
      // her reopen birini geri getirir, dongu sirayla kapatir.
      if (!(ham.windows || []).length) {
        await run("/usr/bin/osascript", ["-e", `tell application "${this.appName}" to reopen`,
          "-e", `tell application "${this.appName}" to activate`]).catch(() => {});
        await this.computer.request({ action: "wait", payload: { seconds: 3 } });
        gunluk.push("pencere geri getirildi (reopen)");
        continue;
      }
      await this.computer.request({ action: "wait", payload: { seconds: 2 } });
    }
    return { ok: false, devices: [], gunluk,
      mesaj: "Cihaz listesi getirilemedi. Windows App'te açık bir oturum veya uyarı penceresi kalmış olabilir." };
  }

  // 3-5. adim: hedefi birebir dogrula, belirsizse DURDUR, degilse kartin
  // KENDI merkezine tikla (koordinat tahmini yok).
  async baglan(hedef, { beklenenKimlik = "" } = {}) {
    if (!this.computer) throw new Error("Bilgisayar köprüsü yok; bağlantı açılamaz.");
    this._kaydet(hedef, { ...yeniDurum(hedef, beklenenKimlik), connection_state: "listeleniyor", current_step: "cihaz listesi okunuyor", started_at: new Date().toISOString() });
    // Ekrani once bilinen duruma getir: takilmis uyari/oturum penceresi varsa
    // cihaz listesi hic gorunmez ve hedef "bulunamadi" sanilir.
    const hazirlik = await this.cihazListesiniHazirla();
    if (!hazirlik.ok) {
      this._kaydet(hedef, { connection_state: "hata", current_step: "cihaz listesi getirilemedi", error: hazirlik.mesaj, finished_at: new Date().toISOString() });
      throw new Error(hazirlik.mesaj);
    }
    const { devices, sidebar } = await this.listele();
    const secim = hedefSec(devices, hedef);
    if (!secim.ok) {
      this._kaydet(hedef, { connection_state: "hata", current_step: "hedef doğrulanamadı", error: secim.message, finished_at: new Date().toISOString() });
      throw new Error(secim.message);
    }
    // Kenar cubugunda "Devices" varsa once ona gec: Favorites goruntusunde
    // baska magazanin karti one cikip yanlis baglanti aciliyordu.
    const devicesDugmesi = sidebar.find((s) => /^devices$/i.test(s.name));
    if (devicesDugmesi) {
      await this.computer.request({ action: "click", payload: { x: devicesDugmesi.x, y: devicesDugmesi.y } });
      await this.computer.request({ action: "wait", payload: { seconds: 1 } });
      // Sekme degistigi icin liste yeniden okunur ve hedef TEKRAR dogrulanir.
      const tazeleme = await this.listele();
      const tekrar = hedefSec(tazeleme.devices, hedef);
      if (!tekrar.ok) {
        this._kaydet(hedef, { connection_state: "hata", current_step: "hedef sekme değişince kayboldu", error: tekrar.message, finished_at: new Date().toISOString() });
        throw new Error(tekrar.message);
      }
      secim.device = tekrar.device;
    }
    this._kaydet(hedef, { connection_state: "baglaniyor", current_step: `"${secim.device.name}" kartı açılıyor` });
    await this.computer.request({ action: "double_click", payload: { x: secim.device.x, y: secim.device.y } });
    await this.computer.request({ action: "wait", payload: { seconds: 4 } });
    return this._kaydet(hedef, { connection_state: "dogrulaniyor", current_step: "uzak masaüstü yükleniyor" });
  }

  // ---- Sunucu kimligi sabitleme (IP pinleme) ----
  // Sertifika uyarisi her baglantida cikiyor ve ajan gecemezse hicbir
  // sunucuya giremiyor. Korukoru "Continue" tiklatmak ise araya giren sahte
  // bir sunucuyu da sessizce kabul etmek olur. Cozum: cihaz basina BEKLENEN
  // HOST sabitlenir. Ilk gorulen hostu KULLANICI onaylar; sonraki turlarda
  // ayni host ise ajan kendisi gecer, host DEGISMISSE durur ve sorar.
  _pinDosyasi() { return path.join(this.dataRoot, "rdp-hosts.json"); }
  pinleriOku() {
    try { return JSON.parse(fs.readFileSync(this._pinDosyasi(), "utf8")); } catch { return {}; }
  }
  pinYaz(cihaz, host) {
    const pinler = this.pinleriOku();
    pinler[cihaz] = { host, at: new Date().toISOString() };
    try { fs.mkdirSync(this.dataRoot, { recursive: true }); fs.writeFileSync(this._pinDosyasi(), JSON.stringify(pinler, null, 2)); } catch {}
    return pinler[cihaz];
  }
  pinSil(cihaz) {
    const pinler = this.pinleriOku();
    delete pinler[cihaz];
    try { fs.writeFileSync(this._pinDosyasi(), JSON.stringify(pinler, null, 2)); } catch {}
  }

  // Acik bir sertifika penceresi varsa OTOMATIK gecilir: bunlar kullanicinin
  // KENDI sunuculari ve her baglantida bu uyari cikiyor; onay beklemek
  // sistemi kullanilamaz kiliyordu (kullanici karari).
  // Guvenlik tamamen birakilmadi: adres cihaza sabitlenir ve DEGISIRSE
  // baglanti yine acilir ama YUKSEK ONEMLI bir uyari dusurulur — sessiz
  // kalmaz, kullanici gorur.
  // Pencere BAGLANTI SIRASINDA cikar, hemen degil: tek seferlik bakis onu
  // kaciriyordu (canli olculdu — 3. saniyede bakildi, pencere sonra cikti ve
  // kimlik dogrulamasi "beklenen sunucu degil" dedi). Bu yuzden araliklarla
  // birkac kez bakilir.
  async sertifikaKarari(hedef, { deneme = 8, araSaniye = 2 } = {}) {
    let pencere = null, buttons = [], texts = [];
    for (let i = 0; i < deneme; i++) {
      ({ buttons = [], texts = [] } = await this.listele({ ham: true }));
      pencere = sertifikaPenceresi(texts, buttons);
      if (pencere) break;
      if (i < deneme - 1) await this.computer.request({ action: "wait", payload: { seconds: araSaniye } });
    }
    if (!pencere) return { durum: "yok" };
    if (!pencere.devam) return { durum: "belirsiz", pencere, mesaj: "Sertifika penceresi var ama onay düğmesi bulunamadı." };
    const pin = this.pinleriOku()[hedef];
    let uyari = null;
    if (pencere.host) {
      if (!pin) this.pinYaz(hedef, pencere.host);
      else if (pin.host !== pencere.host) {
        uyari = `"${hedef}" sunucusunun adresi değişmiş: kayıtlı ${pin.host} → şimdi ${pencere.host}. Bağlantı açıldı; adres değişikliğini siz yapmadıysanız kontrol edin.`;
        this.pinYaz(hedef, pencere.host);
        this.bulguEkle(hedef, { tur: "oturum", ozet: uyari, onem: "yuksek" });
      }
    }
    await this.computer.request({ action: "click", payload: { x: pencere.devam.x, y: pencere.devam.y } });
    await this.computer.request({ action: "wait", payload: { seconds: 2 } });
    return { durum: "gecildi", host: pencere.host, uyari };
  }

  // 6. adim: acilan pencere GERCEKTEN beklenen sunucu mu? Ekran goruntusu
  // kanit olarak saklanir; dogrulamayi cagiran katman (uye) yapar ama karar
  // buraya YAZILIR — kanitsiz "bagliyim" durumu olusmaz.
  async kimlikKaniti(hedef) {
    const sonuc = await this.computer.request({ action: "screenshot", payload: {} });
    return this._kaydet(hedef, { last_screenshot: sonuc.screenshotPath || null, current_step: "kimlik kanıtı alındı" });
  }

  kimlikOnayla(hedef, dogruMu, not = "") {
    if (!dogruMu) {
      return this._kaydet(hedef, { connection_state: "hata", current_step: "beklenen sunucu değil", error: not || "Açılan masaüstü beklenen sunucu değil; oturum kapatılmalı.", finished_at: new Date().toISOString() });
    }
    return this._kaydet(hedef, { connection_state: "gozlemde", current_step: not || "gözlem başladı" });
  }

  bulguEkle(hedef, bulgu) {
    const kayit = this.durumlar.get(hedef);
    if (!kayit) return null;
    kayit.findings.push({ at: new Date().toISOString(), ...bulgu });
    return kayit;
  }

  // 10. adim: oturumu kapat ve cihaz listesine DONULDUGUNU dogrula.
  async kapat(hedef) {
    this._kaydet(hedef, { connection_state: "kapaniyor", current_step: "oturum kapatılıyor" });
    // Oturum penceresi Cmd+W ile kapanir. (Escape + Cmd+Delete yanlisti:
    // pencere kapanmiyordu, canli olculdu.) Kapanis, oturum penceresinin
    // AX agacindan KAYBOLMASIYLA dogrulanir; "bastim, olmustur" yetmez.
    for (let deneme = 0; deneme < 3; deneme++) {
      await this.computer.request({ action: "key", payload: { key: "w", cmd: true } }).catch(() => {});
      await this.computer.request({ action: "wait", payload: { seconds: 2 } });
      let hala = true;
      try {
        const { windows, devices } = await this.listele();
        hala = oturumPenceresi(windows, hedef).ok;
        if (!hala && devices.length > 0) break;
      } catch { hala = true; }
      if (!hala) break;
    }
    let listeGeldi = false;
    try {
      const { windows, devices } = await this.listele();
      listeGeldi = devices.length > 0 && !oturumPenceresi(windows, hedef).ok;
    } catch { listeGeldi = false; }
    return this._kaydet(hedef, {
      connection_state: listeGeldi ? "bitti" : "hata",
      current_step: listeGeldi ? "cihaz listesine dönüldü" : "cihaz listesine dönülemedi",
      error: listeGeldi ? null : "Oturum kapatıldı sayılamadı; sıradaki sunucuya GEÇİLMEZ.",
      finished_at: new Date().toISOString(),
    });
  }
}
