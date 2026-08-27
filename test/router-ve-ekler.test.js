// Router anahtari, ek numaralama ve salt-okunur kosuda merge kapisi.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { attachmentPrompt } from "../src/media.js";
import { normalizeRoute } from "../src/validation.js";
import { resolveTurnRoute } from "../src/orchestrator.js";

const oku = (yol) => fs.readFileSync(new URL(`../${yol}`, import.meta.url), "utf8");

// ---- ROUTER ----
test("router ust seritte, ajan seridinin SOLUNDA", () => {
  const html = oku("ui/index.html");
  const router = html.indexOf('id="btn-router"');
  const ajanlar = html.indexOf('id="tb-agents"');
  assert.ok(router > -1, "router düğmesi olmalı");
  assert.ok(router < ajanlar, "router, ajan şeridinin solunda olmalı");
});

test("router acikken ajan avatarlari bunu belli eder", () => {
  const app = oku("ui/app.js");
  const css = oku("ui/style.css");
  assert.match(app, /classList\.toggle\("router-acik", acik\)/);
  assert.match(css, /#tb-agents\.router-acik \.mini-agent/);
  assert.match(css, /\.router-dugme\[aria-pressed="true"\]/);
});

test("koordinator kademe secer, kademe yolda kaybolmaz", () => {
  assert.match(oku("src/coordinator.js"), /"tier": "fast\|balanced\|strong"/,
    "yönlendirme şeması kademe istemeli");
  // normalizeRoute kademeyi tasir; bilinmeyen deger dengeliye duser.
  assert.equal(normalizeRoute({ approach: "quick", tier: "fast" }, ["m1"]).tier, "fast");
  assert.equal(normalizeRoute({ approach: "quick", tier: "sacma" }, ["m1"]).tier, "balanced");
  // Zorlanan kademede de router'in secimi korunur.
  const r = resolveTurnRoute({ forced: "quick", routed: { member_id: "m1", tier: "strong" } });
  assert.equal(r.tier, "strong");
});

test("router KAPALIYKEN kademe modeli uygulanmaz", async () => {
  const { Orchestrator } = await import("../src/orchestrator.js");
  const o = Object.create(Orchestrator.prototype);
  o.config = { data: { smartModels: false } };
  assert.equal(o.pickTierModel("claude", "fast"), undefined, "kapalıyken üye kendi modeliyle çalışır");
  o.config = { data: { smartModels: true } };
  assert.equal(o.pickTierModel("claude", "fast"), "haiku");
  assert.equal(o.pickTierModel("codex", "fast"), "gpt-5.6-luna");
  assert.equal(o.pickTierModel("claude", "strong"), "opus");
});

// ---- EK NUMARALAMA ----
test("gorseller numaralanir; arada dosya olsa da gorsel sayaci bozulmaz", () => {
  const metin = attachmentPrompt([
    { name: "a.png", kind: "image", mime: "image/png", size: 1, path: "/a.png" },
    { name: "r.pdf", kind: "document", mime: "application/pdf", size: 2, path: "/r.pdf" },
    { name: "b.png", kind: "image", mime: "image/png", size: 3, path: "/b.png" },
  ]);
  assert.match(metin, /\[1\. görsel\] a\.png/);
  assert.match(metin, /\[2\. görsel\] b\.png/);
  assert.match(metin, /toplam 2 görsel/);
  // Tek gorselde numaralama notu gereksiz gurultu yapmaz.
  const tek = attachmentPrompt([{ name: "a.png", kind: "image", mime: "image/png", size: 1, path: "/a.png" }]);
  assert.ok(!/toplam/.test(tek));
});

test("arayuzde gorunen numara uyeye giden numarayla ayni", () => {
  assert.match(oku("ui/app.js"), /const no = \+\+gorselSayaci/);
  assert.match(oku("ui/style.css"), /\.attach-no\{/);
});

// ---- SALT-OKUNUR KOSUDA MERGE KAPISI ----
test("salt-okunur kosu merge kapisinda olmez", () => {
  const ork = oku("src/orchestrator.js");
  const i = ork.indexOf('enforceEvidenceGate(run,"merge"');
  const onceki = ork.slice(Math.max(0, i - 900), i);
  assert.match(onceki, /if \(run\.mode !== "code"\) \{/,
    "rapor koşusu merge kapısına hiç girmemeli");
  assert.match(onceki, /otomatik birleştirme yapılmadı/);
});
