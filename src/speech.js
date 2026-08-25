// Sesli giris: WAV dosyasindan metin.
//
// Neden boyle: tarayicidaki webkitSpeechRecognition Google sunucusuna
// baglanir; Electron paketinde bu ucnokta yoktur, bu yuzden mikrofon dugmesi
// gorunurde calisiyor ama HIC metin uretmiyordu (kullanici bildirdi).
//
// Yerine macOS'un KENDI konusma tanimasi (Speech framework, SFSpeechRecognizer)
// kullanilir: arayuz sesi WebAudio ile ham PCM olarak toplayip WAV yapar,
// sunucuya yollar, burada kucuk bir Swift yardimcisi dosyayi Turkce cozer.
// Sifir bagimlilik korunur (swiftc macOS'ta hazir gelir) ve ses BILGISAYARDAN
// DISARI CIKMAZ — cozumleme yerelde yapilir.
//
// Not: ilk kullanimda macOS "Konusma Tanima" izni ister.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SWIFT_SRC = `import Foundation
import Speech

// Kullanim: cozumle <ses-dosyasi> <dil> <cikti-dosyasi>
// Sonuc STDOUT yerine dosyaya yazilir: uygulama LaunchServices ("open -W")
// ile baslatildigi icin stdout cagirana ulasmaz.
// Dosyayi yerel konusma tanimayla metne cevirir ve stdout'a yazar.
let args = CommandLine.arguments
guard args.count >= 2 else { FileHandle.standardError.write("dosya yolu gerekli".data(using: .utf8)!); exit(2) }
let url = URL(fileURLWithPath: args[1])
let dil = args.count > 2 ? args[2] : "tr-TR"
let ciktiYolu = args.count > 3 ? args[3] : ""
func yaz(_ metin: String) {
  guard !ciktiYolu.isEmpty else { print(metin); return }
  try? metin.write(toFile: ciktiYolu, atomically: true, encoding: .utf8)
}

let bekle = DispatchSemaphore(value: 0)
var cikisKodu: Int32 = 1

SFSpeechRecognizer.requestAuthorization { durum in
  guard durum == .authorized else {
    yaz("!HATA izin-yok: Sistem Ayarları > Gizlilik ve Güvenlik > Konuşma Tanıma bölümünde izin verin.")
    bekle.signal(); return
  }
  guard let taniyici = SFSpeechRecognizer(locale: Locale(identifier: dil)), taniyici.isAvailable else {
    yaz("!HATA tanıyıcı-yok: \\(dil) için yerel tanıma bulunamadı.")
    bekle.signal(); return
  }
  let istek = SFSpeechURLRecognitionRequest(url: url)
  istek.requiresOnDeviceRecognition = false
  istek.shouldReportPartialResults = false
  taniyici.recognitionTask(with: istek) { sonuc, hata in
    if let hata = hata {
      yaz("!HATA \\(hata.localizedDescription)")
      bekle.signal(); return
    }
    guard let sonuc = sonuc, sonuc.isFinal else { return }
    yaz(sonuc.bestTranscription.formattedString)
    cikisKodu = 0
    bekle.signal()
  }
}
_ = bekle.wait(timeout: .now() + 90)
exit(cikisKodu)
`;

const PLIST_SRC = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.ajankonseyi.cozumle</string>
  <key>CFBundleName</key><string>Ajan Konseyi Ses Cozumleyici</string>
  <key>CFBundleExecutable</key><string>cozumle</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
  <key>NSSpeechRecognitionUsageDescription</key><string>Ajan Konseyi, sesli girişinizi metne çevirmek için konuşma tanımayı kullanır.</string>
  <key>NSMicrophoneUsageDescription</key><string>Sesli giriş kaydı Ajan Konseyi arayüzünde yapılır.</string>
</dict></plist>
`;

function run(cmd, args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).slice(0, 300)));
      else resolve(String(stdout).trim());
    });
  });
}

export class SpeechToText {
  constructor(dataRoot) {
    this.binDir = path.join(dataRoot, "bin");
    // TCC (gizlilik kapisi) ciplak bir komut satiri ikilisinin gomulu
    // Info.plist'ini OKUMAZ; izin aciklamasi ancak gercek bir paket
    // (.app) icinden gorunur. Bu yuzden yardimci minik bir uygulama
    // paketi olarak kurulur. (Canli olculdu: imzali+gomulu plist bile
    // "usage description yok" diye cokuyordu.)
    this.appDir = path.join(this.binDir, "AjanSesCozumleyici.app");
    this.bin = path.join(this.appDir, "Contents", "MacOS", "cozumle");
  }

  available() { return process.platform === "darwin" && fs.existsSync("/usr/bin/swiftc"); }

  async ensureTool() {
    if (fs.existsSync(this.bin)) return this.bin;
    if (!this.available()) throw new Error("Yerel konuşma tanıma yalnız macOS'ta çalışır (swiftc gerekli).");
    fs.mkdirSync(this.binDir, { recursive: true });
    const src = path.join(this.binDir, "cozumle.swift");
    fs.writeFileSync(src, SWIFT_SRC);
    // Konusma tanima izni ISTEYEN bir ikili, kullanim aciklamasi olmadan
    // aninda cokuyor (SIGABRT, canli olculdu). Komut satiri araclarinda
    // Info.plist bir bundle'dan degil, __TEXT,__info_plist bolumunden okunur.
    const macosDir = path.join(this.appDir, "Contents", "MacOS");
    fs.mkdirSync(macosDir, { recursive: true });
    fs.writeFileSync(path.join(this.appDir, "Contents", "Info.plist"), PLIST_SRC);
    await run("/usr/bin/swiftc", ["-O", "-o", this.bin, src]);
    // Imza: TCC izin kaydini kod kimligine baglar; ad-hoc imza yeter ve
    // kullanicinin izni yardimci her derlendiginde sifirlanmaz.
    await run("/usr/bin/codesign", ["-s", "-", "--force", "--identifier", "com.ajankonseyi.cozumle", this.appDir]);
    return this.bin;
  }

  // WAV baytlarini metne cevirir. Cagiran gecici dosyayi temizler.
  async transcribe(buffer, { lang = "tr-TR", tmpDir } = {}) {
    const bin = await this.ensureTool();
    const dir = tmpDir || this.binDir;
    fs.mkdirSync(dir, { recursive: true });
    const damga = Date.now();
    const file = path.join(dir, `ses-${damga}.wav`);
    const cikti = path.join(dir, `ses-${damga}.txt`);
    fs.writeFileSync(file, buffer);
    try {
      // TCC (gizlilik kapisi) izni SORUMLU SURECE gore verir: yardimci,
      // Ajan Konseyi uygulamasinin cocugu olarak calistigi icin iznin
      // aciklamasi uygulamanin Info.plist'inden okunur (assets/extend-info).
      // Sonuc stdout yerine dosyaya yazilir; boylece yardimci ileride
      // LaunchServices ile de baslatilabilir.
      await run(bin, [file, lang, cikti], 120_000).catch((error) => {
        if (/SIGABRT|status 134|Command failed/i.test(String(error.message))) {
          throw new Error("Konuşma tanıma izni verilmemiş görünüyor. Sistem Ayarları > Gizlilik ve Güvenlik > Konuşma Tanıma bölümünde \"Ajan Konseyi\"ni açıp yeniden deneyin.");
        }
        throw error;
      });
      if (!fs.existsSync(cikti)) throw new Error("Ses çözümlenemedi (sonuç üretilmedi).");
      const metin = fs.readFileSync(cikti, "utf8").trim();
      if (metin.startsWith("!HATA")) throw new Error(metin.slice(5).trim());
      return metin;
    } finally {
      for (const f of [file, cikti]) { try { fs.unlinkSync(f); } catch {} }
    }
  }
}
