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

function jsonAyikla(metin) {
  const ham = String(metin || "");
  const blok = ham.match(/\{[\s\S]*\}/);
  if (!blok) return null;
  try { return JSON.parse(blok[0]); } catch { return null; }
}

export class OpsRun {
  constructor({ controller, orchestrator, store, config }) {
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
    const sonuc = await this.orch.callMember(run, uye, istem, {
      isolated: true, images: ekranYolu ? [ekranYolu] : [],
      media: ekranYolu ? [{ path: ekranYolu, name: "ekran.png", mime: "image/png", kind: "image" }] : [],
      label: "ekran yorumu", timeoutMs: 180_000,
    });
    return { ok: sonuc.ok !== false, metin: String(sonuc.text || ""), json: jsonAyikla(sonuc.text) };
  }

  async gozlemle(hedef, { memberId = null } = {}) {
    if (this.aktif) throw new Error(`Zaten bir gözlem sürüyor: ${this.aktif.target}`);
    const uye = (this.config?.data?.members || []).find((m) => m.enabled && (!memberId || m.id === memberId));
    if (!uye) throw new Error("Etkin üye yok");
    const bilgisayar = this.controller.computer;
    if (!bilgisayar) throw new Error("Bilgisayar köprüsü yok");

    const run = this.store.createRun({ kind: "chat", request: `Gözlem turu: ${hedef}`, mode: "auto",
      agents: [uye.id], projectId: null, projectDir: null, attachments: [] });
    run.status = "idle";
    run.title = `🖥 Gözlem · ${hedef}`;
    this.store.updateRun(run);
    this.aktif = { target: hedef, runId: run.id, iptal: false };
    const bilgi = (metin) => this.store.addMessage(run, { from: "sistem", kind: "info", content: metin });
    const durdurulduMu = () => { if (this.aktif?.iptal) throw new Error("Gözlem kullanıcı tarafından durduruldu"); };

    try {
      bilgi(`▶ Gözlem turu başladı — hedef: **${hedef}** (Faz 1: yalnız okuma, hiçbir işlem yapılmaz)`);

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
        bilgi(`🔒 Sertifika uyarısı geçildi — adres **${sertifika.host}** bu cihaz için daha önce onaylanmıştı.`);
      } else if (sertifika.durum !== "yok") {
        this.bekleyenOnay = { target: hedef, ...sertifika };
        this.controller._kaydet(hedef, { connection_state: "hata", current_step: "kullanıcı onayı bekliyor", error: sertifika.mesaj });
        bilgi(`⏸ ${sertifika.mesaj}`);
        return this._bitir(run, hedef, "onay-bekliyor", sertifika.mesaj);
      }
      // 7) Yuklenmeyi bekle, 6) kimligi DOGRULA.
      await bilgisayar.request({ action: "wait", payload: { seconds: 5 } });
      const kanit = await this.controller.kimlikKaniti(hedef);
      const kimlik = await this._uyeyeSor(run, uye, KIMLIK_ISTEMI.replace("%HEDEF%", hedef), kanit.last_screenshot);
      const eslesiyor = kimlik.json?.eslesiyor === true && Number(kimlik.json?.guven || 0) >= 60;
      this.store.addMessage(run, { from: uye.id, fromLabel: uye.name, provider: uye.provider, kind: "message",
        content: `**Kimlik doğrulaması:** ${eslesiyor ? "✓ beklenen sunucu" : "✗ doğrulanamadı"}\n${kimlik.json?.kanit || kimlik.metin.slice(0, 400)}`,
        attachments: kanit.last_screenshot ? [{ name: "kimlik-kanit.png", path: kanit.last_screenshot, kind: "image", mime: "image/png" }] : [] });
      if (!eslesiyor) {
        this.controller.kimlikOnayla(hedef, false, kimlik.json?.not || "kimlik doğrulanamadı");
        bilgi("⛔ Beklenen sunucu doğrulanamadı — gözlem yapılmadan oturum kapatılıyor.");
        await this.controller.kapat(hedef);
        return this._bitir(run, hedef, "kimlik-dogrulanamadi");
      }
      this.controller.kimlikOnayla(hedef, true, "kimlik doğrulandı, gözlem başlıyor");
      durdurulduMu();

      // 8-9) Gozlem: ekrani oku, bulgulari kaydet. (Yalniz okuma.)
      const gozlem = await bilgisayar.request({ action: "screenshot", payload: {} });
      this.controller._kaydet(hedef, { last_screenshot: gozlem.screenshotPath, current_step: "ekran okunuyor" });
      const rapor = await this._uyeyeSor(run, uye, GOZLEM_ISTEMI.replace("%HEDEF%", hedef), gozlem.screenshotPath);
      for (const bulgu of rapor.json?.bulgular || []) this.controller.bulguEkle(hedef, bulgu);
      this.store.addMessage(run, { from: uye.id, fromLabel: uye.name, provider: uye.provider, kind: "message",
        content: this._raporMetni(hedef, rapor),
        attachments: gozlem.screenshotPath ? [{ name: "gozlem.png", path: gozlem.screenshotPath, kind: "image", mime: "image/png" }] : [] });

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
