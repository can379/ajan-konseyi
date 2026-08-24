import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const ELECTRON = path.join(ROOT, "node_modules", ".bin", "electron");
const HARNESS = path.join(ROOT, "scripts", "e2e-project-chat-menu.cjs");
const PORT = process.env.E2E_PORT || 4899;
const CONFIG = path.join(ROOT, "config.json");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function serverReady(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return true; } catch {}
    await wait(500);
  }
  return false;
}

// Gercek Electron penceresinde gercek fare olaylariyla calisan uctan uca test.
// Regex tabanli kaynak kontrolu yerine davranisi olcer.
test("proje sohbeti satiri: tiklama, hover menusu ve konumlandirma gercek Electron faresiyle dogrulanir", async (t) => {
  if (!fs.existsSync(ELECTRON)) return t.skip("electron kurulu degil");

  const configBackup = fs.existsSync(CONFIG) ? fs.readFileSync(CONFIG, "utf8") : null;
  const server = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: "ignore",
  });
  let raw = "";
  try {
    assert.ok(await serverReady(`http://127.0.0.1:${PORT}/api/state`), "test sunucusu ayaga kalkmadi");

    const state = await (await fetch(`http://127.0.0.1:${PORT}/api/state`)).json();
    const hasProjectChat = Object.values(state.runs || {}).some(
      (run) => run.kind === "chat" && run.projectId && !run.deletedAt);
    if (!hasProjectChat) return t.skip("projeye bagli sohbet yok");

    const child = spawn(ELECTRON, [HARNESS], {
      cwd: ROOT, env: { ...process.env, E2E_URL: `http://127.0.0.1:${PORT}` },
    });
    child.stdout.on("data", (d) => { raw += d; });
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve("timeout"); }, 120000);
      child.on("close", (c) => { clearTimeout(timer); resolve(c); });
    });
    assert.notEqual(code, "timeout", "electron testi zaman asimina ugradi");

    const line = raw.split("\n").find((l) => l.startsWith("E2E_RESULT:"));
    assert.ok(line, "electron sonucu alinamadi:\n" + raw.slice(-800));
    const r = JSON.parse(line.slice("E2E_RESULT:".length));
    if (r.skipped) return t.skip(r.skipped);
    assert.ok(!r.error, "harness hatasi: " + r.error);

    // 1) Satir kapsayicidan tasmaz (menu capasi dogru olsun diye sart)
    assert.ok(r.satirTasmiyor, "sohbet satiri kenar cubugundan tasiyor");
    // 2) Proje sohbetine hover YALNIZ sohbet menusunu acar
    assert.ok(r.hover.sohbetMenusuAcik, "sohbet menusu acilmadi");
    assert.ok(r.hover.projeMenusuKapali, "proje menusu yanlislikla acildi");
    // 3) Menu satirin hemen saginda, ekran icinde ve ustte
    assert.ok(r.hover.satirinHemenSaginda, "menu satirin hemen saginda degil");
    assert.ok(r.hover.ekranIcinde, "menu pencere sinirlarini asti");
    assert.ok(r.hover.menuUstte, "menu baska bir katmanin altinda kaldi");
    // 4) Sol panel acik kalir
    assert.ok(r.hover.sidebarAcik && r.tiklama.sidebarAcikKaldi, "sol panel kapandi");
    // 5) Satirdan menuye gecerken menu kapanmaz
    assert.ok(r.menuyeGecince.acikKaldi, "satirdan menuye gecerken menu kapandi");
    // 6) Yeniden render davranisi bozmaz
    assert.ok(r.renderSonrasi.sohbetMenusuAcik && r.renderSonrasi.projeMenusuKapali,
      "yeniden render sonrasi hover davranisi bozuldu");
    // 7) Proje basligi kendi menusunu acar, ikisi ayni anda acik kalmaz
    assert.ok(r.projeBasligi.projeMenusuAcik, "proje menusu acilmadi");
    assert.ok(r.projeBasligi.ikisiBirdenAcikDegil, "iki menu ayni anda acik kaldi");
    assert.ok(r.sohbeteDonus.sohbetMenusuAcik && r.sohbeteDonus.projeMenusuKapali,
      "sohbete donunce proje menusu kapanmadi");
    // 8) Fare uzaklasinca kapanir
    assert.ok(r.uzaklasinca.kapandi, "fare uzaklasinca menu kapanmadi");
    // 9) Tiklama sohbeti acar ve dinleyici coklanmaz
    assert.ok(r.tiklama.sohbetAcildi, "tiklama sohbeti acmadi");
    assert.equal(r.tiklama.domSecili, r.hedef.run, "secili satir DOM'da isaretlenmedi");
    assert.equal(r.tiklama.tiklamaSayaci, 1, "tek tiklama birden fazla kez islendi (coklanan dinleyici)");
  } finally {
    server.kill("SIGTERM");
    if (configBackup !== null) fs.writeFileSync(CONFIG, configBackup);
  }
});

// Yapisal guvence: satir menusu tek, paylasilan ve delegasyon tabanli olmali.
test("kenar cubugu menusu tek paylasilan delegasyon bilesenidir", () => {
  const app = fs.readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../ui/style.css", import.meta.url), "utf8");
  assert.match(app, /function bindSidebarMenus\(\)/);
  assert.match(app, /sidebar\.addEventListener\("pointerover"/);
  assert.match(app, /function syncSidebarHover\(\)/);
  // Satir basina mouseenter dinleyicisi eklenmemeli (coklanma kaynagi).
  assert.doesNotMatch(app, /row\.addEventListener\("mouseenter"/);
  // Grid tasmasi menuyu ekranin ortasina firlatiyordu.
  assert.match(css, /\.project-runs\{display:grid;grid-template-columns:minmax\(0,1fr\)/);
});
