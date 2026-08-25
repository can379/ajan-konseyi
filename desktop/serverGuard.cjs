// Sunucu bekcisinin saf parcalari: gunluk dosyasi ve yeniden dogma gecikmesi.
//
// Iki gercek aciktan dogdu: sunucu surecinin gunlugu "ignore" oldugu icin
// oldugunde SEBEP iz birakmiyordu, ve masaustu kabuk olumu fark etmeyip
// yeniden baslatmiyordu — arayuz sayaclari bosa akmaya devam ediyordu.
// Electron'a bagimli olmayan mantik burada yasar ki Node testleriyle
// dogrulanabilsin; main.cjs yalniz baglar.

const fs = require("node:fs");
const path = require("node:path");

const MAX_LOG_BYTES = 5 * 1024 * 1024;

// Gunluk buyuyunce tek nesil dondurulur (.old). Amaci adli tip: olumden
// onceki son satirlar her zaman okunabilir kalsin, disk de dolmasin.
function rotateIfNeeded(file, maxBytes = MAX_LOG_BYTES) {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > maxBytes) {
      fs.renameSync(file, `${file}.old`);
      return true;
    }
  } catch { /* gunluk donmezse sunucu yine calisir */ }
  return false;
}

function openServerLog(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "server.log");
  rotateIfNeeded(file);
  const stream = fs.createWriteStream(file, { flags: "a" });
  return {
    file,
    stream,
    line(message) {
      try { stream.write(`[${new Date().toISOString()}] ${message}\n`); } catch { /* yut */ }
    },
  };
}

// Yeniden dogma gecikmesi: 1s, 2s, 4s, 8s, ust sinir 15s. Cokme dongusunde
// makineyi bogmaz ama ilk olumde kullanici neredeyse hic beklemez.
function nextRespawnDelay(attempt) {
  return Math.min(15_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

module.exports = { rotateIfNeeded, openServerLog, nextRespawnDelay, MAX_LOG_BYTES };
