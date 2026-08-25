import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODEX_STYLE_CONTRACT } from "../src/orchestrator.js";
import { parseNumstat, diffDelta } from "../src/diffSummary.js";

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

// ---- Yanit bicimi sozlesmesi (ChatGPT'deki Codex canli gozlemlenerek) ----
test("codex yanit sozlesmesi baslik+madde+dogrulama ister", () => {
  assert.match(CODEX_STYLE_CONTRACT, /güncellendi\./);
  assert.match(CODEX_STYLE_CONTRACT, /3-6 kısa madde/);
  assert.match(CODEX_STYLE_CONTRACT, /doğrulamayı belirtsin/);
  assert.match(CODEX_STYLE_CONTRACT, /sed\/grep gibi teknik ayrıntı YOK/);
});

test("sozlesme yalniz kod isinde ve lean disinda eklenir", () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "orchestrator.js"), "utf8");
  assert.match(src, /opts\.style === "codex" && !opts\.lean && !opts\.isolated/);
  assert.match(src, /const responseStyle = mode === "code" \? "codex" : null/);
});

// ---- Diff ozeti ----
test("numstat ayristirilir ve tur farki dogru hesaplanir", () => {
  const once = parseNumstat("10\t2\tindex.html\n5\t0\tstyle.css\n");
  const sonra = parseNumstat("27\t7\tindex.html\n5\t0\tstyle.css\n3\t0\tyeni.js\n");
  const delta = diffDelta(once, sonra);
  assert.equal(delta.fileCount, 2, "degismeyen dosya karta girmemeli");
  const idx = delta.files.find((f) => f.path === "index.html");
  assert.deepEqual([idx.add, idx.del], [17, 5], "onceki turun degisikligi dusulmeli");
  assert.ok(delta.files.some((f) => f.path === "yeni.js"));
  assert.equal(delta.totalAdd, 20);
  assert.equal(diffDelta({}, {}), null, "degisiklik yoksa kart olmamali");
});

// ---- Arayuz sozlesmeleri ----
test("arayuz codex ogelerini cizer", () => {
  const app = fs.readFileSync(path.join(ROOT, "ui", "app.js"), "utf8");
  assert.match(app, /süredir çalışıyor/, "canli sure basligi");
  assert.match(app, /diffCardHTML/, "diff karti");
  assert.match(app, /dosya değişiyor/, "canli dosya cipi");
  assert.match(app, /data-diff-review/, "İncele eylemi");
  assert.match(app, /data-diff-restore/, "Geri Al eylemi");
  const css = fs.readFileSync(path.join(ROOT, "ui", "style.css"), "utf8");
  assert.match(css, /\.live-steps \.step-row:last-child\{opacity/, "simdiki eylem soluk olmali");
  const store = fs.readFileSync(path.join(ROOT, "src", "store.js"), "utf8");
  assert.match(store, /diff = null/, "store diff alanini korumali");
});
