import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const oku = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

// ---- Config: proje sirasi ----

test("projectOrder projeleri verilen siraya dizer, bilinmeyen sona kalir", async () => {
  const { Config } = await import("../src/config.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
  const cfg = new Config(dir);
  cfg.data.projects = [{ id: "a", name: "A", path: "/a" }, { id: "b", name: "B", path: "/b" }, { id: "c", name: "C", path: "/c" }];
  cfg.update({ projectOrder: ["c", "a"] });
  assert.deepEqual(cfg.data.projects.map((p) => p.id), ["c", "a", "b"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- Sunucu: sohbet sirasi PATCH ----

test("run PATCH sortIndex kabul eder", () => {
  const src = oku("server.js");
  assert.match(src, /"sortIndex" in body/, "PATCH sortIndex islemeli");
});

// ---- Arayuz sozlesmeleri ----

test("kenar cubugu satirlari suruklenebilir ve siralama kalicilastirilir", () => {
  const app = oku("ui/app.js");
  assert.match(app, /function runOrderCompare/, "ortak siralama karsilastiricisi olmali");
  assert.match(app, /function bindSidebarDrag/, "surukle-birak denetleyicisi olmali");
  assert.equal((app.match(/draggable="true"/g) || []).length >= 3, true, "proje + iki sohbet listesi suruklenebilir olmali");
  assert.match(app, /projectOrder: ids/, "proje sirasi api/config'e yazilmali");
  assert.match(app, /JSON\.stringify\(\{ sortIndex: i \}\)/, "sohbet sirasi PATCH ile yazilmali");
  const css = oku("ui/style.css");
  assert.match(css, /drop-above/, "birakma hedefi gorsel vurgulanmali");
});

// ---- Siralama mantigi (karsilastirici birebir) ----

test("elle siralanan sohbet tarihe gore olanlarin ustunde durur, sabitli en uste", () => {
  const app = oku("ui/app.js");
  const fn = new Function(`${app.match(/function runOrderCompare[\s\S]*?\n\}/)[0]}; return runOrderCompare;`)();
  const runs = [
    { id: "eski-elle", sortIndex: 1, createdAt: "2026-01-01" },
    { id: "yeni-tarih", createdAt: "2026-08-25" },
    { id: "ilk-elle", sortIndex: 0, createdAt: "2026-02-01" },
    { id: "sabit", pinned: true, createdAt: "2025-01-01" },
  ];
  const sirali = [...runs].sort(fn).map((r) => r.id);
  assert.deepEqual(sirali, ["sabit", "ilk-elle", "eski-elle", "yeni-tarih"]);
});
