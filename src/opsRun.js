// Gozlem turu — FAZ 1: bagla, bak, kapat. Hicbir sey degistirme.
//
// Is bolumu bilerek boyle: DENETLEYICI tiklar (RdpController; hedefi
// erisilebilirlik agacindan adiyla bulur), UYE yalniz EKRANI YORUMLAR
// (izole cagri: terminal, tarayici, dosya, kopru — hepsi kapali).
// Boylece modelin yanlis bir ekran yorumu geri alinamaz bir islem
// yapamaz; yapabilecegi en kotu sey yanlis bir GOZLEM raporudur.
//
// 11 adimlik disiplin (kullanici tarifi):
//  1 Windows App'i ac
//  2 kayitli cihazlari AX agacindan oku
//  3 hedef adini birebir dogrula
//  4 belirsizlik varsa DUR
//  5 hedef karta tikla
//  6 acilan masaustunun BEKLENEN sunucu oldugunu dogrula
//  7 yuklenene kadar sinirli bekle
//  8 kontrol gorevlerini uygula (yalniz okuma)
//  9 bulgulari ve kanit ekran goruntulerini kaydet
// 10 oturumu kapat, cihaz listesine donuldugunu dogrula
// 11 ancak bundan sonra siradaki sunucuya gec

import { oturumPenceresi } from "./rdpController.js";
import { isTuruBul, isYonergesi, OYUN_KITABI, FAZ1_UST_SINIR, gezinmeNotlari } from "./opsPlaybook.js";

const KIMLIK_ISTEMI = `Sana bir uzak masaüstü oturumunun ekran görüntüsü verildi.

TEK GÖREVİN: Bu masaüstünün BEKLENEN sunucu olup olmadığını söylemek.
Beklenen sunucu adı: "%HEDEF%"

Kanıt ara: pencere başlığı, bilgisayar adı, masaüstü kısayolları, açık uygulama başlıkları, saat dilimi/dil ipuçları.

Yalnız şu JSON'u döndür, başka hiçbir şey yazma:
{"eslesiyor": true|false, "guven": 0-100, "kanit": "gördüğün somut işaret", "not": "kısa açıklama"}

Emin değilsen eslesiyor=false ver. Yanlış sunucuda çalışmak, hiç çalışmamaktan kötüdür.`;

const GOZLEM_ISTEMI = `Sana "%HEDEF%" sunucusunun uzak masaüstü ekran görüntüsü verildi.

GÖZLEM MODU: Hiçbir şey yapmayacaksın, yapamazsın da — araçların kapalı. Yalnız EKRANDA NE GÖRDÜĞÜNÜ raporlayacaksın.

Şunları ara ve gördüklerini yaz:
- Açık uygulamalar ve tarayıcı sekmeleri
- eBay/Amazon ile ilgili görünen bir şey (iade, dava, mesaj, sipariş uyarısı, bildirim sayısı)
- Dikkat isteyen bir durum (hata penceresi, oturum süresi dolmuş uyarısı, bekleyen onay)

Yalnız şu JSON'u döndür:
{"gorunen_uygulamalar": ["..."], "bulgular": [{"tur": "iade|dava|siparis|oturum|diger", "ozet": "tek cümle", "onem": "dusuk|orta|yuksek"}], "sonraki_adim_onerisi": "tek cümle"}

Görmediğin şeyi yazma. Ekran boşsa veya masaüstü henüz yüklenmediyse bulgular boş kalsın ve bunu not düş.`;

const PLAN_ISTEMI = `Sana "%HEDEF%" sunucusunun ekran görüntüsü ve tespit edilen bir sorun verildi.

TESPİT: %BULGU%

%YONERGE%

GÖREVİN: Bu sorunu yukarıdaki prosedüre göre NASIL çözeceğini yaz. HİÇBİR ŞEY YAPMA — bu bir plan turudur, kullanıcı senin nasıl çalıştığını görmek istiyor.

Yalnız şu JSON'u döndür:
{"yapilabilir": true|false,
 "eksik_bilgi": ["prosedürün ön koşullarından ekranda göremediklerin"],
 "adimlar": [{"no": 1, "ne": "somut adım", "nerede": "hangi ekran/sayfa", "dogrulama": "sonucu nasıl doğrularım"}],
 "durma_noktalari": ["bu işte nerede durup sana sorardım"],
 "tahmini_sure": "kısa tahmin",
 "risk_notu": "para/geri alınamaz etki varsa tek cümle"}

Ekranda göremediğin bir ön koşul varsa uydurma: "eksik_bilgi" listesine yaz ve yapilabilir=false ver.`;

const ARASTIR_ISTEMI = `Sana "%HEDEF%" sunucusunun uzak masaüstü ekran görüntüsü verildi ve bir sorunun eksik bilgileri var.

TESPİT: %BULGU%
EKSİK BİLGİ:
%EKSIK%

%GEZINME%

GÖREVİN: Bu eksik bilgiyi bulmak için uzak masaüstünde NEREYE bakılacağını söyle. YALNIZ OKUMA — hiçbir şey değiştirme, gönderme, tıklayarak işlem yapma. Sayfa açmak, sekme değiştirmek ve kaydı görüntülemek serbesttir.

Ekranda şu an ne görüyorsan ona göre TEK BİR sonraki adım öner. Hedef siteye gitmen gerekiyorsa ÖNCE yer imini dene (eylem="yer_imi"); adres uydurma.
{"eylem": "yer_imi|sekme_degistir|adres_git|kaydir|hazir",
 "hedef": "yer imi adı (Orders/My eBay/.us/Can SellerAI/easync), sekme başlığı veya tam adres",
 "neden": "hangi eksik bilgiyi bulacaksın",
 "beklenen": "o ekranda ne görmeyi bekliyorsun"}

Aradığın bilgi ZATEN ekrandaysa eylem="hazir" ver ve neden alanına gördüğünü yaz. Uzak masaüstünde açık olmayan bir uygulamayı açmaya çalışma; parola/OTP ekranı çıkarsa dur.`;

const GIRIS_OZETI_ISTEMI = `"%HEDEF%" sunucusuna yeni bağlandın. Ekran görüntüsü verildi.

GÖREVİN: Kullanıcıya kısa bir GİRİŞ ÖZETİ yaz. Ne gördüğünü ve bu turda ne yapacağını söyle.

BU TURDAKİ GÖREVLER:
%GOREVLER%

Yalnız şu JSON:
{"gordugum": "ekranda ne var — tek cümle, açık uygulamalar ve dikkat çeken durum",
 "hazir_mi": true|false,
 "engel": "görevleri yapmama engel bir şey varsa (oturum kapalı, hata penceresi), yoksa boş",
 "plan": "bu turda sırayla ne yapacağım — tek cümle"}`;

const GOREV_ISTEMI = `"%HEDEF%" sunucusundasın. Şu görevi yürüteceksin:

%YONERGE%

Ekran görüntüsü verildi. Şu an ekranda ne olduğuna bakıp GÖREVE GİTMEK için TEK bir sonraki adımı söyle.

Yalnız şu JSON:
{"eylem": "yer_imi|adres_git|sekme_degistir|tikla|kaydir|oku|bitti",
 "hedef": "yer imi adı / adres / tıklanacak öğenin GÖRÜNTÜDEKİ piksel konumu {x,y} / okunacak alan",
 "neden": "bu adım görevin neresi",
 "beklenen": "sonrasında ne görmeyi bekliyorum"}

Göreve ulaştıysan ve okunacak şey ekrandaysa eylem="oku" ver ve "hedef" alanına ne okuduğunu yaz.
Görev tamamlandıysa eylem="bitti" ver.
Tıklaman gerekiyorsa hedef alanına {"x":..,"y":..} biçiminde GÖRÜNTÜ pikseli ver; emin değilsen tıklama, başka adım öner.`;

const TUR_OZETI_ISTEMI = `"%HEDEF%" sunucusundaki tur bitti. Yaptıklarının kaydı:

%KAYIT%

GÖREVİN: Kullanıcıya TUR ÖZETİ yaz. Kısa, dürüst ve somut ol. Yapmadığın şeyi yaptım deme.

Yalnız şu JSON:
{"yaptiklarim": ["kısa madde", "..."],
 "buldugum": ["dikkat isteyen somut şey", "..."],
 "yapamadigim": ["denedim ama olmadı / erişemedim", "..."],
 "onerim": "sıradaki adım — tek cümle"}`;

function jsonAyikla(metin) {
  const ham = String(metin || "");
  const blok = ham.match(/\{[\s\S]*\}/);
  if (!blok) return null;
  try { return JSON.parse(blok[0]); } catch { return null; }
}

export class OpsRun {
  constructor({ controller, orchestrator, store, config, jobs = null, faz = null }) {
    this.jobs = jobs;
    this.faz = faz;
    this.controller = controller;
    this.orch = orchestrator;
    this.store = store;
    this.config = config;
    this.aktif = null;      // { target, runId, iptal }
    this.gecmis = [];       // son turlarin ozetleri
  }

  durum() {
    return {
      bekleyenOnay: this.bekleyenOnay || null,
      aktif: this.aktif ? { target: this.aktif.target, runId: this.aktif.runId } : null,
      sunucular: this.controller.tumDurumlar(),
      gecmis: this.gecmis.slice(-20),
    };
  }

  iptalEt() { if (this.aktif) this.aktif.iptal = true; }

  // Uyeye YALNIZ ekran goruntusu ve soru gider; arac/kopru yok (isolated).
  async _uyeyeSor(run, uye, istem, ekranYolu) {
    // Kullanicinin bu tura ozel ek talimati (varsa) her istemin basina gecer.
    if (this._ekTalimat) istem = `--- KULLANICININ EK TALİMATI ---\n${this._ekTalimat}\n--- EK TALİMAT SONU ---\n\n${istem}`;
    // Gorseli SAGLAYICIYA gore iki yoldan birden ver: bazi uyeler dosyayi
    // kendi okuma araciyla acar (Claude), bazilari ek olarak alir (Codex,
    // Antigravity). Yalniz ek olarak vermek yetmiyordu: uye "hicbir ekran
    // goruntusu alinmadi" deyip kimligi dogrulayamiyordu (canli olculdu).
    const yolNotu = ekranYolu
      ? `\n\nEKRAN GÖRÜNTÜSÜ DOSYASI: ${ekranYolu}\nBu dosya sana ek olarak da verildi. Göremiyorsan dosya okuma aracınla bu yolu aç ve GÖRSEL olarak incele — bu iş için okuma iznin var. Dosyayı açamıyorsan bunu açıkça söyle, tahmin yürütme.`
      : "";
    const sonuc = await this.orch.callMember(run, uye, istem + yolNotu, {
      isolated: true, images: ekranYolu ? [ekranYolu] : [],
      media: ekranYolu ? [{ path: ekranYolu, name: "ekran.png", mime: "image/png", kind: "image" }] : [],
      label: "ekran yorumu", timeoutMs: 180_000,
    });
    return { ok: sonuc.ok !== false, metin: String(sonuc.text || ""), json: jsonAyikla(sonuc.text) };
  }

  async gozlemle(hedef, { memberId = null, not = "" } = {}) {
    if (this.aktif) throw new Error(`Zaten bir gözlem sürüyor: ${this.aktif.target}`);
    const uye = (this.config?.data?.members || []).find((m) => m.enabled && (!memberId || m.id === memberId));
    if (!uye) throw new Error("Etkin üye yok");
    const bilgisayar = this.controller.computer;
    if (!bilgisayar) throw new Error("Bilgisayar köprüsü yok");

    const run = this.store.createRun({ kind: "ops", request: `Gözlem turu: ${hedef}`, mode: "auto",
      agents: [uye.id], projectId: null, projectDir: null, attachments: [] });
    run.status = "idle";
    run.title = `🖥 Gözlem · ${hedef}`;
    this.store.updateRun(run);
    this.aktif = { target: hedef, runId: run.id, iptal: false };
    this._ekTalimat = String(not || "").trim();
    const bilgi = (metin) => this.store.addMessage(run, { from: "sistem", kind: "info", content: metin });
    const durdurulduMu = () => { if (this.aktif?.iptal) throw new Error("Gözlem kullanıcı tarafından durduruldu"); };

    try {
      bilgi(`▶ Gözlem turu başladı — hedef: **${hedef}** · üye: **${uye.name}** (Faz 1: yalnız okuma, hiçbir işlem yapılmaz)`);
      if (this._ekTalimat) bilgi(`📌 Ek talimat: ${this._ekTalimat}`);

      // 1) Windows App'i one getir.
      await bilgisayar.request({ action: "open_app", payload: { name: this.controller.appName } });
      await bilgisayar.request({ action: "wait", payload: { seconds: 2 } });
      durdurulduMu();

      // 2-5) Cihazlari oku, hedefi birebir dogrula, karta tikla.
      const { devices } = await this.controller.listele();
      bilgi(`Kayıtlı cihazlar: ${devices.map((d) => d.name).join(", ") || "(yok)"}`);
      await this.controller.baglan(hedef);
      bilgi(`"${hedef}" kartı açıldı; uzak masaüstü yükleniyor.`);
      durdurulduMu();

      // 6a) Sertifika/onay penceresi cikmis olabilir. Ajan bunu KORUKORU
      // gecmez: host cihaza sabitlenmisse ve AYNIYSA gecer; ilk kez
      // goruluyorsa veya host DEGISMISSE durur, karari kullaniciya birakir.
      await bilgisayar.request({ action: "wait", payload: { seconds: 3 } });
      const sertifika = await this.controller.sertifikaKarari(hedef);
      if (sertifika.durum === "gecildi") {
        bilgi(`🔒 Sertifika uyarısı geçildi — sunucu adresi **${sertifika.host || "okunamadı"}**.`);
        if (sertifika.uyari) bilgi(`⚠ ${sertifika.uyari}`);
      } else if (sertifika.durum === "belirsiz") {
        // Pencere var ama dugme okunamadi: korukoru bir yere tiklamak yerine dur.
        this.controller._kaydet(hedef, { connection_state: "hata", current_step: "onay penceresi çözümlenemedi", error: sertifika.mesaj });
        bilgi(`⏸ ${sertifika.mesaj}`);
        return this._bitir(run, hedef, "pencere-cozumlenemedi", sertifika.mesaj);
      }
      // 7) Yuklenmeyi bekle, 6) kimligi DOGRULA.
      await bilgisayar.request({ action: "wait", payload: { seconds: 5 } });
      const kanit = await this.controller.kimlikKaniti(hedef);
      // KESIN dogrulama once: oturum penceresinin basligi cihaz adidir
      // ("[AXWindow] ANNE"). Model yorumu ancak bu yoksa devreye girer —
      // canli olculdu: masaustu tam ekran Chrome oldugunda ekranda hicbir
      // kimlik ipucu kalmiyor ve dogru sunucu bile reddediliyordu.
      let pencereKanidi = null;
      for (let i = 0; i < 6 && !pencereKanidi; i++) {
        const { windows } = await this.controller.listele({ ham: true });
        const bulgu = oturumPenceresi(windows, hedef);
        if (bulgu.ok) pencereKanidi = bulgu.pencere;
        else if (i < 5) await bilgisayar.request({ action: "wait", payload: { seconds: 2 } });
      }
      let kimlik = { json: null, metin: "" };
      let eslesiyor = Boolean(pencereKanidi);
      if (pencereKanidi) {
        bilgi(`✓ Kimlik doğrulandı: oturum penceresi başlığı **${pencereKanidi.title}** (erişilebilirlik ağacından, kesin).`);
      } else {
        kimlik = await this._uyeyeSor(run, uye, KIMLIK_ISTEMI.replace("%HEDEF%", hedef), kanit.last_screenshot);
        eslesiyor = kimlik.json?.eslesiyor === true && Number(kimlik.json?.guven || 0) >= 60;
      }
      this.store.addMessage(run, { from: uye.id, fromLabel: uye.name, provider: uye.provider, kind: "message",
        content: `**Kimlik doğrulaması:** ${eslesiyor ? "✓ beklenen sunucu" : "✗ doğrulanamadı"}\n`
          + (pencereKanidi ? `Oturum penceresi başlığı: **${pencereKanidi.title}**` : (kimlik.json?.kanit || kimlik.metin.slice(0, 400))),
        attachments: kanit.last_screenshot ? [{ name: "kimlik-kanit.png", path: kanit.last_screenshot, kind: "image", mime: "image/png" }] : [] });
      if (!eslesiyor) {
        this.controller.kimlikOnayla(hedef, false, kimlik.json?.not || "kimlik doğrulanamadı");
        bilgi("⛔ Beklenen sunucu doğrulanamadı — gözlem yapılmadan oturum kapatılıyor.");
        await this.controller.kapat(hedef);
        return this._bitir(run, hedef, "kimlik-dogrulanamadi");
      }
      this.controller.kimlikOnayla(hedef, true, "kimlik doğrulandı, gözlem başlıyor");
      durdurulduMu();

      // 7b) GIRIS OZETI — kullanici bildirdi: "her yaptigi seyi sunucuya giris
      // yaptiktan sonra ozet gecsin". Once ne gordugunu ve ne yapacagini yaz.
      const girisEkran = await bilgisayar.request({ action: "screenshot", payload: {} });
      const gorevler = this._gorevler();
      const girisOzet = await this._uyeyeSor(run, uye,
        GIRIS_OZETI_ISTEMI.replace("%HEDEF%", hedef)
          .replace("%GOREVLER%", gorevler.length
            ? gorevler.map((g, i) => `${i + 1}. ${g.ad}`).join("\n")
            : "(açık görev yok — yalnız genel gözlem)"),
        girisEkran.screenshotPath);
      const gj = girisOzet.json;
      this.store.addMessage(run, { from: uye.id, fromLabel: uye.name, provider: uye.provider, kind: "message",
        content: `**${hedef} — giriş özeti**\n\n`
          + `Gördüğüm: ${gj?.gordugum || girisOzet.metin.slice(0, 300)}\n\n`
          + (gj?.engel ? `⚠ Engel: ${gj.engel}\n\n` : "")
          + (gorevler.length ? `Bu turdaki görevler: ${gorevler.map((g) => g.ad).join(", ")}\n\n` : "")
          + (gj?.plan ? `Planım: ${gj.plan}` : ""),
        attachments: girisEkran.screenshotPath ? [{ name: "giris.png", path: girisEkran.screenshotPath, kind: "image", mime: "image/png" }] : [] });

      // 7c) ACIK GOREVLERE GIT. Kullanici bildirdi: "mesajlara filan girmedi".
      const gorevKayitlari = [];
      let gorevEkran = girisEkran.screenshotPath;
      for (const gorev of gorevler) {
        durdurulduMu();
        const sonuc = await this._goreveGit(run, uye, hedef, gorev, gorevEkran);
        gorevKayitlari.push({ gorev: gorev.ad, adimlar: sonuc.kayit });
        gorevEkran = sonuc.sonEkran || gorevEkran;
      }

      // 8-9) Gozlem: ekrani oku, bulgulari kaydet. (Yalniz okuma.)
      const gozlem = { screenshotPath: gorevEkran } ;
      this.controller._kaydet(hedef, { last_screenshot: gozlem.screenshotPath, current_step: "ekran okunuyor" });
      const rapor = await this._uyeyeSor(run, uye, GOZLEM_ISTEMI.replace("%HEDEF%", hedef), gozlem.screenshotPath);
      // Her bulguyu bir IS TURUNE bagla: boylece "ne yapilmali" sorusu
      // ajanin dogaclamasina degil, CanSellerAI'daki gercek prosedure baglanir.
      for (const bulgu of rapor.json?.bulgular || []) {
        const isTuru = isTuruBul(bulgu);
        const oyun = isTuru ? OYUN_KITABI[isTuru] : null;
        this.controller.bulguEkle(hedef, {
          ...bulgu,
          isTuru: isTuru || null,
          isAdi: oyun?.ad || null,
          risk: oyun ? oyun.risk : null,
          // Faz 1'de risk 2+ isler YAPILMAZ; hazirlanir ve onaya birakilir.
          durum: oyun ? (oyun.risk <= FAZ1_UST_SINIR ? "yapilabilir" : "onay-bekliyor") : "siniflanmadi",
        });
      }
      this.store.addMessage(run, { from: uye.id, fromLabel: uye.name, provider: uye.provider, kind: "message",
        content: this._raporMetni(hedef, rapor),
        attachments: gozlem.screenshotPath ? [{ name: "gozlem.png", path: gozlem.screenshotPath, kind: "image", mime: "image/png" }] : [] });

      // 9b) PLAN TURU: siniflanan her bulgu icin "bunu nasil cozerdim" —
      // uygulamadan. Kullanici Faz 1'de ajanin NASIL calistigini gormek
      // istiyor; plan bunu gosterir, oyun kitabina bagli oldugu icin de
      // dogaclama degil gercek prosedurdur.
      const planlananlar = this.controller.durum(hedef)?.findings?.filter((b) => b.isTuru) || [];
      for (const bulgu of planlananlar.slice(-3)) {
        durdurulduMu();
        const yonerge = isYonergesi(bulgu.isTuru);
        const plan = await this._uyeyeSor(run, uye,
          PLAN_ISTEMI.replace("%HEDEF%", hedef)
            .replace("%BULGU%", `${bulgu.isAdi || bulgu.tur}: ${bulgu.ozet}`)
            .replace("%YONERGE%", yonerge || ""),
          gozlem.screenshotPath);
        bulgu.plan = plan.json || { ham: plan.metin.slice(0, 1500) };
        // Plan "eksik bilgi" diyorsa uydurma: uzak masaustunde ARA (yalniz okuma).
        if (bulgu.plan?.yapilabilir === false && (bulgu.plan.eksik_bilgi || []).length) {
          const arastirma = await this._arastir(run, uye, hedef, bulgu, gozlem.screenshotPath);
          if (arastirma.toplanan.length) {
            bulgu.arastirma = arastirma.toplanan;
            // Toplanan bilgiyle plani TAZELE — artik daha az bosluk olmali.
            const tazePlan = await this._uyeyeSor(run, uye,
              PLAN_ISTEMI.replace("%HEDEF%", hedef)
                .replace("%BULGU%", `${bulgu.isAdi || bulgu.tur}: ${bulgu.ozet}\nAraştırmada görülenler: ${arastirma.toplanan.join(" | ")}`)
                .replace("%YONERGE%", yonerge || ""),
              arastirma.sonEkran);
            if (tazePlan.json) bulgu.plan = tazePlan.json;
          }
        }
        this.store.addMessage(run, { from: uye.id, fromLabel: uye.name, provider: uye.provider, kind: "message",
          content: this._planMetni(hedef, bulgu) });
      }
      this.store.updateRun(run);

      // 9c) Bulgular ISE donusur (kuyruk). Idempotens anahtari sayesinde ayni
      // sorun icin ikinci is ACILMAZ — cift siparis/cift iade buradan onlenir.
      // Faz siniri: risk 2+ isler "kullanici bekliyor" olarak acilir, otomatik
      // yurutulmez.
      if (this.jobs) {
        for (const bulgu of this.controller.durum(hedef)?.findings || []) {
          if (!bulgu.isTuru || bulgu.isKimlik) continue;
          const varlik = this._varlikKimligi(bulgu);
          if (!varlik) continue;   // kimliksiz bulgu ise donusturulemez
          const sonuc = this.jobs.ekle({
            isTuru: bulgu.isTuru, hesap: hedef, varlikId: varlik,
            risk: bulgu.risk ?? 3,
            veri: { ozet: bulgu.ozet, onem: bulgu.onem, plan: bulgu.plan || null, tur: run.id },
          });
          bulgu.isKimlik = sonuc.is?.id || null;
          if (sonuc.ok && (bulgu.risk ?? 3) > FAZ1_UST_SINIR) {
            this.jobs.kullaniciBekle(sonuc.is.id, `Faz 1: risk ${bulgu.risk} iş onay olmadan yürütülmez`);
          }
          if (sonuc.yinelenen) bilgi(`↺ Bu iş zaten kuyrukta (${sonuc.is.durum}); ikinci kez açılmadı.`);
        }
        this.store.updateRun(run);
      }

      // 10b) TUR OZETI — yaptiklarinin tam dokumu.
      const kayitMetni = [
        `Bağlantı: ${hedef} · sertifika geçildi · kimlik doğrulandı`,
        ...gorevKayitlari.map((g) => `Görev "${g.gorev}": ${g.adimlar.join(" → ") || "adım yok"}`),
        `Bulgular: ${(this.controller.durum(hedef)?.findings || []).map((b) => `${b.isAdi || b.tur}: ${b.ozet}`).join(" | ") || "yok"}`,
      ].join("\n");
      const ozet = await this._uyeyeSor(run, uye,
        TUR_OZETI_ISTEMI.replace("%HEDEF%", hedef).replace("%KAYIT%", kayitMetni.slice(0, 6000)), gorevEkran);
      const oj = ozet.json;
      this.store.addMessage(run, { from: uye.id, fromLabel: uye.name, provider: uye.provider, kind: "message",
        content: `**${hedef} — tur özeti**\n\n`
          + ((oj?.yaptiklarim || []).length ? `**Yaptıklarım**\n${oj.yaptiklarim.map((x) => `- ${x}`).join("\n")}\n\n` : "")
          + ((oj?.buldugum || []).length ? `**Bulduklarım**\n${oj.buldugum.map((x) => `- ${x}`).join("\n")}\n\n` : "")
          + ((oj?.yapamadigim || []).length ? `**Yapamadıklarım**\n${oj.yapamadigim.map((x) => `- ${x}`).join("\n")}\n\n` : "")
          + (oj?.onerim ? `**Öneri:** ${oj.onerim}\n\n` : "")
          + (oj ? "" : ozet.metin.slice(0, 1500)) });

      // 10) Oturumu kapat ve cihaz listesine donuldugunu dogrula.
      const kapanis = await this.controller.kapat(hedef);
      bilgi(kapanis.connection_state === "bitti"
        ? "✓ Oturum kapatıldı, cihaz listesine dönüldü."
        : "⚠ Oturum kapatıldığı doğrulanamadı — sıradaki sunucuya geçilmez.");
      return this._bitir(run, hedef, kapanis.connection_state === "bitti" ? "tamam" : "kapanis-dogrulanamadi");
    } catch (hata) {
      const mesaj = String(hata.message || hata);
      this.controller._kaydet(hedef, { connection_state: "hata", error: mesaj, finished_at: new Date().toISOString() });
      this.store.addMessage(run, { from: "sistem", kind: "error", content: `Gözlem durdu: ${mesaj}` });
      return this._bitir(run, hedef, "hata", mesaj);
    }
  }

  // Eksik bilgiyi UZAK MASAUSTUNDE arar: sekme degistirir, adres acar, okur.
  // Faz 1 siniri: yalniz okuma. Hicbir form doldurulmaz, hicbir sey gonderilmez.
  // Her adimda ekran yeniden okunur — korukoru tiklama yok.
  async _arastir(run, uye, hedef, bulgu, ekranYolu, { maxAdim = 3 } = {}) {
    const bilgisayar = this.controller.computer;
    const bilgi = (m) => this.store.addMessage(run, { from: "sistem", kind: "info", content: m });
    const toplanan = [];
    let sonEkran = ekranYolu;
    for (let i = 0; i < maxAdim; i++) {
      const eksik = (bulgu.plan?.eksik_bilgi || []).map((x) => `- ${x}`).join("\n") || "- (belirtilmedi)";
      const oneri = await this._uyeyeSor(run, uye,
        ARASTIR_ISTEMI.replace("%HEDEF%", hedef)
          .replace("%BULGU%", `${bulgu.isAdi || bulgu.tur}: ${bulgu.ozet}`)
          .replace("%EKSIK%", eksik)
          .replace("%GEZINME%", gezinmeNotlari(bulgu.isTuru) || ""),
        sonEkran);
      const adim = oneri.json;
      if (!adim || adim.eylem === "hazir") {
        if (adim?.neden) toplanan.push(adim.neden);
        break;
      }
      // Uzak masaustunde gezinme: sekme degistirme Cmd/Ctrl+Tab yerine
      // dogrudan adres cubugu kullanilir (uzak Windows'ta Ctrl+L).
      if (adim.eylem === "yer_imi" && adim.hedef) {
        // Yer imi cubugundaki kisayola tikla: AX agacindan adiyla bulunur,
        // koordinat tahmini yok. (Uzak masaustu icerigi AX'e kapali oldugu
        // icin burada gorsel konum kullanilir; bulunamazsa DURULUR.)
        bilgi(`🔖 Araştırma: **${adim.hedef}** yer imi açılıyor — ${adim.neden || "eksik bilgi"}`);
        const yer = await this._yerImiKonumu(hedef, adim.hedef, sonEkran, run, uye);
        if (!yer) { bilgi(`⏸ "${adim.hedef}" yer imi bulunamadı; araştırma durduruldu.`); break; }
        await bilgisayar.request({ action: "click", payload: { x: yer.x, y: yer.y } });
        await bilgisayar.request({ action: "wait", payload: { seconds: 5 } });
      } else if (adim.eylem === "adres_git" && adim.hedef) {
        bilgi(`🔎 Araştırma: **${adim.hedef}** açılıyor — ${adim.neden || "eksik bilgi"}`);
        await bilgisayar.request({ action: "key", payload: { key: "l", ctrl: true } });
        await bilgisayar.request({ action: "wait", payload: { seconds: 1 } });
        await bilgisayar.request({ action: "type", payload: { text: String(adim.hedef).slice(0, 300) } });
        await bilgisayar.request({ action: "key", payload: { key: "enter" } });
        await bilgisayar.request({ action: "wait", payload: { seconds: 5 } });
      } else if (adim.eylem === "sekme_degistir") {
        bilgi(`🔎 Araştırma: sekme değiştiriliyor — ${adim.neden || ""}`);
        await bilgisayar.request({ action: "key", payload: { key: "tab", ctrl: true } });
        await bilgisayar.request({ action: "wait", payload: { seconds: 3 } });
      } else if (adim.eylem === "kaydir") {
        await bilgisayar.request({ action: "key", payload: { key: "down" } });
        await bilgisayar.request({ action: "wait", payload: { seconds: 1 } });
      } else break;
      const yeni = await bilgisayar.request({ action: "screenshot", payload: {} });
      sonEkran = yeni.screenshotPath;
      this.controller._kaydet(hedef, { last_screenshot: sonEkran, current_step: `araştırma: ${adim.hedef || adim.eylem}` });
      toplanan.push(`${adim.hedef || adim.eylem}: ${adim.beklenen || ""}`);
    }
    return { toplanan, sonEkran };
  }

  // Bu turda hangi gorevler var? Acik is turleri gorevi belirler; hicbiri
  // acik degilse tur yalniz genel gozlemdir.
  _gorevler() {
    const acik = this.faz ? [...(this.faz.acikTurler || [])] : [];
    return acik.filter((t) => OYUN_KITABI[t]).map((t) => ({ isTuru: t, ad: OYUN_KITABI[t].ad }));
  }

  // Goreve GIT: ekrana bakip adim adim ilerler. Yalniz okuma eylemleri;
  // tiklama yalniz gezinme icin (yer imi, sekme, bag). Kullanici bildirdi:
  // "mesajlara filan girmedi" — onceki tur ekranda ne varsa onu okuyup
  // biraktigi icin acik gorev es geciliyordu.
  async _goreveGit(run, uye, hedef, gorev, ekranYolu, { maxAdim = 6 } = {}) {
    const bilgisayar = this.controller.computer;
    const bilgi = (m) => this.store.addMessage(run, { from: "sistem", kind: "info", content: m });
    const yonerge = isYonergesi(gorev.isTuru, { fazUstSinir: this.faz?.ustSinir ?? 1 });
    const kayit = [];
    let sonEkran = ekranYolu;
    bilgi(`🎯 Görev: **${gorev.ad}** — hedefe gidiliyor.`);
    for (let i = 0; i < maxAdim; i++) {
      if (this.aktif?.iptal) break;
      const oneri = await this._uyeyeSor(run, uye,
        GOREV_ISTEMI.replace("%HEDEF%", hedef).replace("%YONERGE%", yonerge || gorev.ad), sonEkran);
      const adim = oneri.json;
      if (!adim || adim.eylem === "bitti") { if (adim?.neden) kayit.push(adim.neden); break; }

      if (adim.eylem === "oku") {
        kayit.push(`okundu: ${typeof adim.hedef === "string" ? adim.hedef : JSON.stringify(adim.hedef)}`);
        bilgi(`👁 ${String(adim.hedef).slice(0, 300)}`);
        continue;
      }
      if (adim.eylem === "yer_imi" && adim.hedef) {
        const yer = await this._yerImiKonumu(hedef, String(adim.hedef), sonEkran, run, uye);
        if (!yer) { bilgi(`⏸ "${adim.hedef}" yer imi bulunamadı — görev durduruldu.`); break; }
        bilgi(`🔖 ${adim.hedef} açılıyor — ${adim.neden || ""}`);
        await bilgisayar.request({ action: "click", payload: { x: yer.x, y: yer.y } });
        await bilgisayar.request({ action: "wait", payload: { seconds: 4 } });
      } else if (adim.eylem === "adres_git" && adim.hedef) {
        bilgi(`🔎 ${adim.hedef} — ${adim.neden || ""}`);
        await bilgisayar.request({ action: "key", payload: { key: "l", ctrl: true } });
        await bilgisayar.request({ action: "wait", payload: { seconds: 1 } });
        await bilgisayar.request({ action: "type", payload: { text: String(adim.hedef).slice(0, 300) } });
        await bilgisayar.request({ action: "key", payload: { key: "enter" } });
        await bilgisayar.request({ action: "wait", payload: { seconds: 5 } });
      } else if (adim.eylem === "tikla" && adim.hedef?.x != null) {
        // Uzak masaustu icerigi AX'te gorunmez; konum gorselden gelir.
        // Retina: goruntu pikseli / 2 = ekran noktasi.
        bilgi(`🖱 Tıklanıyor — ${adim.neden || ""}`);
        await bilgisayar.request({ action: "click",
          payload: { x: Math.round(Number(adim.hedef.x) / 2), y: Math.round(Number(adim.hedef.y) / 2) } });
        await bilgisayar.request({ action: "wait", payload: { seconds: 3 } });
      } else if (adim.eylem === "sekme_degistir") {
        await bilgisayar.request({ action: "key", payload: { key: "tab", ctrl: true } });
        await bilgisayar.request({ action: "wait", payload: { seconds: 3 } });
      } else if (adim.eylem === "kaydir") {
        await bilgisayar.request({ action: "key", payload: { key: "down" } });
        await bilgisayar.request({ action: "wait", payload: { seconds: 1 } });
      } else break;

      const yeni = await bilgisayar.request({ action: "screenshot", payload: {} });
      sonEkran = yeni.screenshotPath;
      this.controller._kaydet(hedef, { last_screenshot: sonEkran, current_step: `${gorev.ad}: ${adim.eylem}` });
      kayit.push(`${adim.eylem}${adim.hedef && typeof adim.hedef === "string" ? " → " + adim.hedef : ""}`);
    }
    return { kayit, sonEkran };
  }

  // Bulgudan VARLIK KIMLIGI cikar (siparis no, iade no, dava no). Kimlik
  // yoksa is ACILMAZ: idempotens anahtari olmadan cift islem onlenemez.
  _varlikKimligi(bulgu) {
    const metin = `${bulgu?.ozet || ""} ${JSON.stringify(bulgu?.plan || {})}`;
    // eBay siparis: 12-34567-89012 · Amazon siparis: 123-1234567-1234567
    const amazon = metin.match(/\b\d{3}-\d{7}-\d{7}\b/)?.[0];
    const ebay = metin.match(/\b\d{2}-\d{5}-\d{5}\b/)?.[0];
    const iade = metin.match(/[Rr]eturn\s*ID\s*:?\s*(\d{6,})/)?.[1] || metin.match(/\biade\s*(?:no|numarası)\s*:?\s*(\d{6,})/i)?.[1];
    const dava = metin.match(/\b(?:case|dava)\s*(?:id|no)?\s*:?\s*([\w-]{6,})/i)?.[1];
    return ebay || amazon || iade || dava || null;
  }

  // Yer imi konumu: uzak masaustu icerigi yerel AX agacinda GORUNMEZ
  // (RDP tek bir goruntu olarak gelir). Bu yuzden konum uyeye gorselden
  // sorulur; bulunamazsa TAHMIN EDILMEZ, arastirma durur.
  async _yerImiKonumu(hedef, yerImiAdi, ekranYolu, run, uye) {
    const istem = `Ekran görüntüsünde uzak masaüstündeki tarayıcının YER İMLERİ ÇUBUĞU var.

"${yerImiAdi}" adlı yer imini bul ve TAM KONUMUNU ver.

Yalnız şu JSON: {"bulundu": true|false, "x": <görüntü pikseli>, "y": <görüntü pikseli>, "etiket": "okuduğun yazı"}

Görüntü pikseli ver (ekran noktası değil). Emin değilsen bulundu=false — yanlış yere tıklamak, hiç tıklamamaktan kötüdür.`;
    const yanit = await this._uyeyeSor(run, uye, istem, ekranYolu);
    const j = yanit.json;
    if (!j?.bulundu || !Number.isFinite(Number(j.x)) || !Number.isFinite(Number(j.y))) return null;
    // Retina: goruntu pikseli -> ekran noktasi.
    return { x: Math.round(Number(j.x) / 2), y: Math.round(Number(j.y) / 2), etiket: j.etiket || yerImiAdi };
  }

  // Plan kullaniciya OKUNUR bicimde sunulur: ne yapardi, nerede dururdu.
  _planMetni(hedef, bulgu) {
    const p = bulgu.plan || {};
    if (p.ham) return `**${hedef} · ${bulgu.isAdi || bulgu.tur} — plan**\n${p.ham}`;
    const adimlar = (p.adimlar || []).map((a) => `${a.no}. ${a.ne}${a.nerede ? ` _(${a.nerede})_` : ""}${a.dogrulama ? `\n   ↳ doğrulama: ${a.dogrulama}` : ""}`).join("\n");
    const risk = bulgu.risk != null ? ` · risk ${bulgu.risk}` : "";
    return `**${hedef} · ${bulgu.isAdi || bulgu.tur} — nasıl çözerdim${risk}**\n\n`
      + `${bulgu.ozet}\n\n`
      + (p.yapilabilir === false ? `⚠ Şu an yapılamaz — eksik bilgi:\n${(p.eksik_bilgi || []).map((x) => `- ${x}`).join("\n")}\n\n` : "")
      + (adimlar ? `Adımlar:\n${adimlar}\n\n` : "")
      + ((p.durma_noktalari || []).length ? `Nerede sana sorardım:\n${p.durma_noktalari.map((x) => `- ${x}`).join("\n")}\n\n` : "")
      + (p.risk_notu ? `Risk: ${p.risk_notu}\n\n` : "")
      + `_Plan turu — hiçbir işlem yapılmadı._`;
  }

  _raporMetni(hedef, rapor) {
    const j = rapor.json;
    if (!j) return `**${hedef} — gözlem**\n${rapor.metin.slice(0, 2000)}`;
    const bulgular = (j.bulgular || []).map((b) => `- **${b.tur}** (${b.onem}): ${b.ozet}`).join("\n");
    return `**${hedef} — gözlem raporu**\n\n`
      + `Görünen uygulamalar: ${(j.gorunen_uygulamalar || []).join(", ") || "—"}\n\n`
      + (bulgular ? `Bulgular:\n${bulgular}\n\n` : "Bulgu yok.\n\n")
      + (j.sonraki_adim_onerisi ? `Öneri: ${j.sonraki_adim_onerisi}\n\n` : "")
      + `_Faz 1: yalnız gözlem — hiçbir işlem yapılmadı._`;
  }

  _bitir(run, hedef, sonuc, hata = null) {
    this.store.updateRun(run, { status: "idle", phase: "idle" });
    const durum = this.controller.durum(hedef);
    const ozet = { target: hedef, runId: run.id, sonuc, hata, at: new Date().toISOString(),
      bulguSayisi: durum?.findings?.length || 0 };
    this.gecmis.push(ozet);
    this.aktif = null;
    return ozet;
  }
}
