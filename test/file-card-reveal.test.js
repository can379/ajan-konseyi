import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const PORT = 4897;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Dosya kartlari masaustu uygulamada Finder'a gitmeli; /api/media/reveal ucu
// bu isin sunucu ayagidir. Yol kacagi ve olmayan dosya 404 ile reddedilir
// (open -R hic calistirilmadan).
test("media/reveal yalniz uploads icindeki mevcut dosyayi kabul eder", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reveal-"));
  fs.mkdirSync(path.join(dataDir, "uploads"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "gizli.txt"), "sir");
  const server = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), AJAN_KONSEYI_DATA_DIR: dataDir }, stdio: "ignore",
  });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/api/mcp/info`)).ok; } catch { await wait(400); } }
    assert.ok(up, "test sunucusu ayaga kalkmadi");
    const post = (url) => fetch(`http://127.0.0.1:${PORT}/api/media/reveal`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }),
    });
    assert.equal((await post("/uploads/olmayan.zip")).status, 404, "olmayan dosya reddedilmeli");
    assert.equal((await post("/uploads/../gizli.txt")).status, 404, "yol kacagi reddedilmeli");
  } finally {
    server.kill("SIGKILL");
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// Arayuz sozlesmesi: kart yerel gosterim niteligi tasir ve tiklama isleyicisi
// yedege dusen indirme yolunu korur.
test("dosya karti reveal niteligi tasir ve isleyici yedekli calisir", () => {
  const app = fs.readFileSync(path.join(ROOT, "ui", "app.js"), "utf8");
  assert.match(app, /class="file-card"[^>]*data-reveal-url=/, "kartta data-reveal-url olmali");
  assert.match(app, /a\.file-card\[data-reveal-url\]/, "delege tiklama isleyicisi olmali");
  assert.match(app, /api\/media\/reveal/, "isleyici reveal ucunu cagirmali");
  assert.match(app, /window\.open\(revealCard\.href/, "basarisizlikta indirme yedegi kalmali");
});

// Mesaj icindeki `/Users/...` kod parcalari tiklanabilir olmali; siradan kod
// parcalari ise olmamali.
test("mutlak yol kod parcasi tiklanabilir, siradan kod degil", () => {
  const app = fs.readFileSync(path.join(ROOT, "ui", "app.js"), "utf8");
  assert.match(app, /data-reveal-path="\$\{value\}"/, "yol kod parcasina nitelik eklenmeli");
  assert.match(app, /code\[data-reveal-path\]/, "yol tiklamasi dinlenmeli");
});

test("reveal ev dizini icindeki yolu kabul eder, disini reddeder", async () => {
  const os = await import("node:os");
  const dataDir = fs.mkdtempSync(path.join(os.default.tmpdir(), "reveal2-"));
  const homeFile = path.join(os.default.homedir(), `.ajan-reveal-test-${Date.now()}`);
  fs.writeFileSync(homeFile, "test");
  const PORT = 4895;
  const server = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), AJAN_KONSEYI_DATA_DIR: dataDir }, stdio: "ignore",
  });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/api/mcp/info`)).ok; } catch { await wait(400); } }
    assert.ok(up, "sunucu ayaga kalkmadi");
    const post = (body) => fetch(`http://127.0.0.1:${PORT}/api/media/reveal`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal((await post({ path: homeFile })).status, 200, "ev icindeki mevcut dosya kabul edilmeli");
    assert.equal((await post({ path: "/etc/hosts" })).status, 404, "ev disindaki sistem yolu reddedilmeli");
    assert.equal((await post({ path: path.join(os.default.homedir(), "olmayan-dosya-xyz.txt") })).status, 404);
  } finally {
    server.kill("SIGKILL");
    fs.unlinkSync(homeFile);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// Baglar bag gibi: kutu/cerceve yok; kod ici URL'ler ve ciplak URL'ler de
// tiklanir; siradan kod notr kalir.
test("url kod parcalari ve ciplak url'ler baglanir, stil kutusuz", () => {
  const app = fs.readFileSync(path.join(ROOT, "ui", "app.js"), "utf8");
  assert.match(app, /class="code-link" href="\$\{value\}" target="_blank"/, "kod ici URL bag olmali");
  assert.match(app, /https\?:\\\/\\\/\[\^\\s<>"'\)\]/, "ciplak URL otomatik baglanmali");
  const css = fs.readFileSync(path.join(ROOT, "ui", "style.css"), "utf8");
  assert.match(css, /code\.code-link[^{]*\{[^}]*background:transparent/s, "kutu arka plani olmamali");
  assert.match(css, /\.code-link[^}]*border:0/s, "cerceve olmamali");
});
