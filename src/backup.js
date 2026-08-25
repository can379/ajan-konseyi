// Veri yedekleme: fotograf/video (uploads, generated), sohbetler (runs),
// hafiza ve yapilandirma tek hedef klasore AYNALANIR.
//
// Hedef bir Google Drive masaustu esitleme klasoru olabilir: dosya oraya
// yazildigi anda Drive istemcisi buluta tasir; boylece OAuth, API anahtari
// veya ek bagimlilik gerekmez (projenin sifir-bagimlilik ilkesi korunur).
//
// Ayna EKLEyicidir: hedefte asla silme yapilmaz. Kaynakta silinen dosya
// hedefte kalir — yedegin amaci tam da bu.

import fs from "node:fs";
import path from "node:path";

// Kontrol noktalari BILEREK disaridadir: projenin tam anlik goruntusudur
// (olculdu: tek nokta ~5 GB), yerelde en yeni 3 taneye budanir ve projenin
// kendisinden yeniden uretilebilir. Buluta tasinirsa her yeni noktada
// gigabaytlar yeniden yuklenir. Yedegin amaci geri getirilemez veridir:
// fotograf/video (uploads, generated), sohbetler (runs), hafiza, ayarlar.
export const BACKUP_SETS = ["uploads", "generated", "runs", "memory"];
export const BACKUP_FILES = ["config.json", "workspace-state.json"];

// Google Drive masaustu uygulamasinin esitleme koku (kuruluysa).
export function detectGoogleDrive(homeDir) {
  const cloud = path.join(homeDir, "Library", "CloudStorage");
  try {
    const entry = fs.readdirSync(cloud).find((name) => name.startsWith("GoogleDrive-"));
    if (!entry) return null;
    for (const sub of ["My Drive", "Drive'ım"]) {
      const root = path.join(cloud, entry, sub);
      if (fs.existsSync(root)) return root;
    }
    return path.join(cloud, entry);
  } catch { return null; }
}

// Degisiklik olcutu boyut+mtime'dir: 6+ GB veri her seferinde okunup
// ozetlenmez; degismeyen dosya kopyalanmaz.
function needsCopy(src, dest) {
  try {
    const a = fs.statSync(src);
    if (!a.isFile()) return false;
    const b = fs.statSync(dest);
    return a.size !== b.size || a.mtimeMs > b.mtimeMs + 1000;
  } catch { return true; }
}

export function mirrorTree(srcDir, destDir, stats) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === ".DS_Store" || entry.name.endsWith(".tmp")) continue;
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) { mirrorTree(src, dest, stats); continue; }
    if (!entry.isFile()) continue;
    if (needsCopy(src, dest)) {
      try {
        fs.copyFileSync(src, dest);
        stats.copied += 1;
        stats.bytes += fs.statSync(src).size;
      } catch (error) {
        stats.errors.push(`${src}: ${String(error.message || error)}`);
      }
    } else {
      stats.skipped += 1;
    }
  }
}

export function runBackup(dataRoot, targetDir) {
  const started = Date.now();
  const root = path.join(targetDir, "AjanKonseyi-Yedek");
  const stats = { copied: 0, skipped: 0, bytes: 0, errors: [] };
  fs.mkdirSync(root, { recursive: true });
  for (const set of BACKUP_SETS) mirrorTree(path.join(dataRoot, set), path.join(root, set), stats);
  for (const file of BACKUP_FILES) {
    const src = path.join(dataRoot, file);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(root, file);
    if (needsCopy(src, dest)) {
      try { fs.copyFileSync(src, dest); stats.copied += 1; stats.bytes += fs.statSync(src).size; }
      catch (error) { stats.errors.push(`${src}: ${String(error.message || error)}`); }
    } else stats.skipped += 1;
  }
  const result = {
    at: new Date().toISOString(),
    durationMs: Date.now() - started,
    target: root,
    copied: stats.copied,
    skipped: stats.skipped,
    bytes: stats.bytes,
    errors: stats.errors.slice(0, 20),
  };
  try { fs.writeFileSync(path.join(root, "yedek-durum.json"), JSON.stringify(result, null, 2)); } catch {}
  return result;
}
