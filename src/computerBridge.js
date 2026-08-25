// Bilgisayar kullanimi koprusu (kullanici acik izniyle eklendi).
//
// Konsey uyeleri (Claude/Codex/Antigravity) ana uygulama uzerinden ekrani
// gorebilir ve fare/klavye kullanabilir — tipki kullanicinin Erisilebilirlik
// izniyle yaptigi gibi. Amac: "sen erisilebilirlikle bilgisayari
// kullanabildin, yazilim da kullanabilsin" (kullanici talebi).
//
// GUVENLIK MODELI — bu kopru bilerek dar tutulmustur:
// - Her sohbet turunda ILK bilgisayar eylemi kullanici ONAYINA baglidir
//   (orkestrator store.requestApproval ile sorar); onay tur boyunca gecerli.
// - Kullanici adi/parola, OTP ve odeme alanlarini uye DOLDURMAZ; yardim
//   metni bunu acikca soyler ve boyle bir alan gorunce kullaniciya birakir.
// - Eylem kumesi sabittir (asagidaki liste); kabuk komutu calistirmaz.
// - Her eylem adim gunlugune yazilir; kullanici ne yapildigini gorur.
//
// Gerekli macOS izinleri (Sistem Ayarlari > Gizlilik ve Guvenlik):
// - Erisilebilirlik → Ajan Konseyi (fare/klavye)
// - Ekran Kaydi → Ajan Konseyi (ekran goruntusu)
// Izin yoksa eylem, hangi izni acmasi gerektigini soyleyen bir hata dondurur.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const COMPUTER_ACTIONS = ["screenshot", "click", "double_click", "type", "key", "open_app"];

function run(cmd, args, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).slice(0, 400)));
      else resolve(String(stdout));
    });
  });
}

// Fare olaylari icin kucuk bir yardimci: AppleScript'in "click at" komutu
// canli olcumde guvenilmez cikti (yanlis yere dustu, menuyu acti); CGEvent
// ile HID duzeyinde tiklama tutarli calisiyor.
const CLICK_SWIFT = `import CoreGraphics
import Foundation
let args = CommandLine.arguments
guard args.count >= 3, let x = Double(args[1]), let y = Double(args[2]) else { exit(2) }
let cift = args.count > 3 && args[3] == "cift"
let nokta = CGPoint(x: x, y: y)
func tikla(_ sayi: Int64) {
  guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: nokta, mouseButton: .left),
        let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: nokta, mouseButton: .left) else { exit(3) }
  down.setIntegerValueField(.mouseEventClickState, value: sayi)
  up.setIntegerValueField(.mouseEventClickState, value: sayi)
  down.post(tap: .cghidEventTap)
  usleep(40_000)
  up.post(tap: .cghidEventTap)
}
CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: nokta, mouseButton: .left)?.post(tap: .cghidEventTap)
usleep(60_000)
tikla(1)
if cift { usleep(90_000); tikla(2) }
`;

// AppleScript dizesine gomulen metin kacislanir (tirnak/ters bolu).
function asString(text) {
  return '"' + String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

const KEY_CODES = {
  enter: 36, return: 36, tab: 48, esc: 53, escape: 53, space: 49,
  delete: 51, up: 126, down: 125, left: 123, right: 124,
};

export class ComputerBridge {
  constructor(dataRoot) {
    this.dataRoot = dataRoot;
    this.binDir = path.join(dataRoot, "bin");
    this.clickBin = path.join(this.binDir, "tikla");
    this.shotsDir = path.join(dataRoot, "uploads");
  }

  async ensureClickTool() {
    if (fs.existsSync(this.clickBin)) return this.clickBin;
    fs.mkdirSync(this.binDir, { recursive: true });
    const src = path.join(this.binDir, "tikla.swift");
    fs.writeFileSync(src, CLICK_SWIFT);
    await run("/usr/bin/swiftc", ["-O", "-o", this.clickBin, src], 120_000);
    return this.clickBin;
  }

  izinHatasi(error, izin) {
    return new Error(`${String(error.message || error)}\nİzin eksik olabilir: Sistem Ayarları > Gizlilik ve Güvenlik > ${izin} bölümünde "Ajan Konseyi"ni açıp yeniden deneyin.`);
  }

  async request({ action, payload = {} }) {
    if (!COMPUTER_ACTIONS.includes(action)) throw new Error("Desteklenmeyen bilgisayar eylemi: " + action);

    if (action === "screenshot") {
      fs.mkdirSync(this.shotsDir, { recursive: true });
      const file = path.join(this.shotsDir, `ekran-${Date.now()}.png`);
      try { await run("/usr/sbin/screencapture", ["-x", file]); }
      catch (error) { throw this.izinHatasi(error, "Ekran Kaydı"); }
      const boyut = fs.existsSync(file) ? fs.statSync(file).size : 0;
      const not = "Bu PNG'yi kendi dosya okuma aracınla aç ve incele. Retina ekranda EKRAN NOKTASI = PİKSEL / 2; tıklama koordinatlarını buna göre ver.";
      if (boyut < 40_000) {
        return { screenshotPath: file, note: not, warning: "Görüntü şüpheli derecede küçük; Ekran Kaydı izni verilmemiş olabilir (yalnız duvar kağıdı görünüyorsa izni açtırın)." };
      }
      return { screenshotPath: file, note: not };
    }

    if (action === "click" || action === "double_click") {
      const x = Number(payload.x), y = Number(payload.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("click için sayısal x,y (ekran noktası) gerekli");
      try {
        const bin = await this.ensureClickTool();
        await run(bin, [String(x), String(y), ...(action === "double_click" ? ["cift"] : [])]);
      } catch (error) {
        throw this.izinHatasi(error, "Erişilebilirlik");
      }
      return { ok: true, clicked: { x, y }, double: action === "double_click" };
    }

    if (action === "type") {
      const text = String(payload.text || "").slice(0, 2000);
      if (!text) throw new Error("type için text gerekli");
      try { await run("/usr/bin/osascript", ["-e", `tell application "System Events" to keystroke ${asString(text)}`], 60_000); }
      catch (error) { throw this.izinHatasi(error, "Erişilebilirlik"); }
      return { ok: true, typed: `${text.length} karakter` };
    }

    if (action === "key") {
      const ad = String(payload.key || "").toLowerCase();
      const kod = KEY_CODES[ad];
      if (kod === undefined) throw new Error(`Bilinmeyen tuş: ${ad} (geçerli: ${Object.keys(KEY_CODES).join(", ")})`);
      const mods = [];
      if (payload.cmd) mods.push("command down");
      if (payload.shift) mods.push("shift down");
      if (payload.option) mods.push("option down");
      if (payload.ctrl) mods.push("control down");
      const modStr = mods.length ? ` using {${mods.join(", ")}}` : "";
      try { await run("/usr/bin/osascript", ["-e", `tell application "System Events" to key code ${kod}${modStr}`]); }
      catch (error) { throw this.izinHatasi(error, "Erişilebilirlik"); }
      return { ok: true, key: ad, modifiers: mods };
    }

    if (action === "open_app") {
      const ad = String(payload.name || "").slice(0, 80);
      if (!ad) throw new Error("open_app için name gerekli");
      await run("/usr/bin/open", ["-a", ad]);
      return { ok: true, opened: ad };
    }
  }
}

// Uyeye verilen Turkce tarif: eylem -> insan cumlesi (adim gunlugu basligi).
export function describeComputerAction(action) {
  const p = action?.payload || {};
  switch (action?.action) {
    case "screenshot": return { kind: "gorsel", title: "Ekran görüntüsü alındı" };
    case "click": return { kind: "islem", title: `Ekranda tıklandı (${Math.round(p.x)}, ${Math.round(p.y)})` };
    case "double_click": return { kind: "islem", title: `Ekranda çift tıklandı (${Math.round(p.x)}, ${Math.round(p.y)})` };
    case "type": return { kind: "islem", title: "Klavyeyle yazıldı" };
    case "key": return { kind: "islem", title: `Tuşa basıldı: ${p.key}` };
    case "open_app": return { kind: "islem", title: `Uygulama açıldı: ${p.name}` };
    default: return { kind: "islem", title: "Bilgisayar eylemi" };
  }
}
