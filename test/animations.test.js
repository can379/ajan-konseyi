import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const css = fs.readFileSync(path.join(ROOT, "ui", "style.css"), "utf8");
const app = fs.readFileSync(path.join(ROOT, "ui", "app.js"), "utf8");
const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

// Her yapay zekanin kendine ozgu calisma animasyonu: ayni animasyonun dort
// kopyasi degil, dort FARKLI hareket.
test("her saglayicinin kendine ozgu calisma animasyonu var", () => {
  const eslesmeler = {
    claude: /\.live-msg\.from-claude[^{]*\{animation:anim-yildiz/,
    codex: /\.live-msg\.from-codex[^{]*\{animation:anim-nefes/,
    antigravity: /\.live-msg\.from-antigravity[^{]*\{animation:anim-suzul/,
    openrouter: /\.live-msg\.from-openrouter[^{]*\{animation:anim-isilti/,
  };
  for (const [saglayici, desen] of Object.entries(eslesmeler)) {
    assert.match(css, desen, `${saglayici} animasyonu eksik`);
  }
  for (const kare of ["anim-yildiz", "anim-nefes", "anim-suzul", "anim-isilti", "anim-akis"]) {
    assert.match(css, new RegExp(`@keyframes ${kare}`), `${kare} keyframe eksik`);
  }
  assert.match(css, /prefers-reduced-motion/, "hareket azaltma tercihi sayilmali");
});

test("calisan proje nabiz noktasi state'ten beslenir", () => {
  assert.match(server, /devServers: Object\.fromEntries/, "state devServers tasimali");
  assert.match(app, /state\.devServers\?\.\[p\.id\]\?\.alive/, "proje satiri devServers'a bakmali");
  assert.match(css, /\.dev-dot\{[^}]*animation:anim-nabiz/s, "nokta nabiz atmali");
});

// ---- Kenar cubugu calisma animasyonu + yogunluk ikonlari ----

test("calisan sohbet/proje satiri ekolayzer animasyonu tasir", async () => {
  const fs = await import("node:fs");
  const app = fs.readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
  assert.match(app, /function workingEqHTML/, "ortak gosterge ureticisi olmali");
  assert.match(app, /r\.status==="running"\?"working":""/, "proje sohbet satiri working sinifi almali");
  assert.match(app, /run\.status==="running"\?"working":""/, "serbest sohbet satiri working sinifi almali");
  assert.match(app, /calisiyor\?workingEqHTML\("Bu projede bir ajan çalışıyor"\)/, "proje basligi toplu gosterge tasimali");
  const css = fs.readFileSync(new URL("../ui/style.css", import.meta.url), "utf8");
  assert.match(css, /work-eq-bar/, "ekolayzer animasyonu tanimli olmali");
  assert.match(css, /prefers-reduced-motion/, "hareket azaltma saygisi korunmali");
});

test("yogunluk secenekleri kendi ikonlarini tasir (hepsi davul degil)", async () => {
  const fs = await import("node:fs");
  const html = fs.readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
  assert.ok(!html.includes("🥁"), "davul ikonu kalmamali");
  assert.match(html, /⚖️ Dengeli/); assert.match(html, /🌱 Ekonomik/); assert.match(html, /🔬 Titiz/);
});
