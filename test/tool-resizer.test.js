import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const ELECTRON = path.join(ROOT, "node_modules", ".bin", "electron");
const HARNESS = path.join(ROOT, "scripts", "e2e-tool-resizer.cjs");
const PORT = process.env.E2E_PANEL_PORT || 4898;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function serverReady(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return true; } catch {}
    await wait(500);
  }
  return false;
}

// Sag panelin GERCEK fare ile boyutlandirilmasi. Sentetik PointerEvent'ler
// setPointerCapture'i tetiklemedigi icin bu davranis yalniz gercek Electron
// fare olaylariyla olculebilir.
test("araç paneli gerçek fareyle imlece yapışık boyutlanır ve bırakınca durur", async (t) => {
  if (!fs.existsSync(ELECTRON)) return t.skip("electron kurulu degil");
  if (process.env.AJAN_E2E !== "1") return t.skip("E2E: `npm run test:e2e` ile seri çalıştırılır");

  const server = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: "ignore",
  });
  let raw = "";
  try {
    assert.ok(await serverReady(`http://127.0.0.1:${PORT}/api/state`), "test sunucusu ayaga kalkmadi");

    const runHarness = async () => {
      raw = "";
      const child = spawn(ELECTRON, [HARNESS], {
        cwd: ROOT, env: { ...process.env, E2E_URL: `http://127.0.0.1:${PORT}` },
      });
      child.stdout.on("data", (d) => { raw += d; });
      const code = await new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve("timeout"); }, 120000);
        child.on("close", (c) => { clearTimeout(timer); resolve(c); });
      });
      if (code === "timeout") return null;
      const line = raw.split("\n").find((l) => l.startsWith("E2E_RESULT:"));
      return line ? JSON.parse(line.slice("E2E_RESULT:".length)) : null;
    };

    let r = await runHarness();
    if (!r || (!r.error && !r.tutamakGorunur)) r = await runHarness();
    assert.ok(r, "electron testi sonuc uretmedi:\n" + raw.slice(-800));
    assert.ok(!r.error, "harness hatasi: " + r.error);

    // 1) Tutamak görünür olmalı — bazı pencere genişliklerinde tamamen
    //    gizleniyordu ve panel hiç boyutlandırılamıyordu.
    assert.ok(r.tutamakGorunur, "yeniden boyutlandırma tutamağı görünmüyor");

    // 2) Panel imlece yapışık ilerlemeli. Genişlik geçişi sürükleme sırasında
    //    kapatılmazsa panel fareyi geriden takip eder.
    assert.ok(r.imleceYapisik,
      `panel imleci geriden takip ediyor: hedef ${r.hedefGenislik}, gerçekleşen ${r.suruklemeSonuGenislik}`);

    // 3) Fare bırakılınca sürükleme BİTMELİ. Eskiden bitiş fonksiyonu
    //    hasPointerCapture koşuluna bağlıydı; yakalama düşünce sınıf üstte
    //    kalıyor ve boyutlandırma sürüyordu.
    assert.ok(r.suruklemeSinifiTemiz, "bırakıldıktan sonra split-resizing sınıfı üstte kaldı");
    assert.ok(r.birakincaDurdu,
      `bırakıldıktan sonra hareket paneli değiştirdi: ${r.birakmaAnindakiGenislik} → ${r.birakmadanSonrakiGenislik}`);
  } finally {
    server.kill("SIGKILL");
  }
});
