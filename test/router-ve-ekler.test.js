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

test("router acikken model secim kutusunun yaninda uyari yazar", () => {
  const app = oku("ui/app.js");
  // Kullanici: "bu bolumlerde router bagli model secilemez yazisi olmali."
  // Yoksa "modeli Opus yaptim ama Haiku calisti" diye hakli bir sasirma olur.
  assert.match(app, /function routerNotuHTML/);
  assert.match(app, /Router açık — model kademesini işin ağırlığına göre sistem seçiyor/);
  // Not, model secim kutusunun HEMEN ardinda olmali.
  const i = app.indexOf("<select data-mmodel>");
  assert.match(app.slice(i, i + 200), /routerNotuHTML\(\)/);
  // Router kapaliyken not gorunmez.
  assert.match(app, /if \(!state\.config\?\.smartModels\) return "";/);
  // Anahtar cevrilince acik kartlar aninda tazelenir.
  assert.match(app, /if \(!\$\("agent-pop"\)\?\.hidden\) renderAgentPop\(\)/);
  assert.match(app, /renderAgentConfig\(\)/);
  assert.match(oku("ui/style.css"), /\.router-not\{/);
});

// ---- Router AYRI BIR ROL: koordinatorden once ve kendi modeliyle ----
test("router varsayilani Antigravity ve degistirilebilir", async () => {
  const { Config } = await import("../src/config.js");
  const fs = await import("node:fs"); const os = await import("node:os"); const path = await import("node:path");
  const kok = fs.mkdtempSync(path.join(os.tmpdir(), "ajan-router-"));
  const c = new Config(kok);
  // Yonlendirme kisa ve ucuz bir is; agir modeli her mesaj icin harcamak anlamsiz.
  assert.equal(c.data.router.provider, "antigravity");
  assert.equal(c.data.router.effort, "sinirli");
  // Kullanici degistirebilir.
  c.update({ router: { provider: "codex", model: "gpt-5.6-luna", effort: "orta" } });
  assert.equal(c.data.router.provider, "codex");
  assert.equal(c.data.router.model, "gpt-5.6-luna");
  // Diske yazilir ve geri okunur.
  assert.equal(new Config(kok).data.router.provider, "codex");
  // Bilinmeyen saglayici varsayilana duser.
  c.update({ router: { provider: "uydurma" } });
  assert.equal(c.data.router.provider, "antigravity");
});

test("yonlendirme ROUTER rolunde calisir, koordinatorun modelini harcamaz", async () => {
  const { Coordinator } = await import("../src/coordinator.js");
  const cagrilar = [];
  const sahteAjan = (ad) => ({
    isAvailable: () => true, sessions: new Map(),
    send: async (_p, o) => { cagrilar.push({ ad, model: o.model, sessionKey: o.sessionKey }); return { ok: true, text: '{"approach":"quick","member_id":"m1","tier":"fast"}' }; },
  });
  const k = new Coordinator(
    { setAgentStatus() {}, agentStatus: {} },
    { claude: sahteAjan("claude"), antigravity: sahteAjan("antigravity") },
    () => ({ provider: "claude", model: "opus" }),         // koordinator
    () => ({ provider: "antigravity", model: "gemini-3.7-flash-low" }), // router
  );
  await k.routeTurn({ request: "kısa soru", messages: [] }, "m1 | Üye | claude", { runId: "r1" });
  assert.equal(cagrilar.length, 1);
  assert.equal(cagrilar[0].ad, "antigravity", "yönlendirmeyi router yapmalı");
  assert.equal(cagrilar[0].model, "gemini-3.7-flash-low", "router kendi modelini kullanmalı");
  assert.match(cagrilar[0].sessionKey, /#router$/, "router oturumu koordinatörden ayrı olmalı");
});

test("arayuzde router karti koordinatorden ONCE gosterilir", () => {
  const app = oku("ui/app.js");
  assert.match(app, /function routerCardHTML/);
  const i = app.indexOf("routerCardHTML() +");
  const j = app.indexOf("coordinatorCardHTML() +", i);
  assert.ok(i > -1 && j > i, "akış sırası: önce router, sonra koordinatör");
  // Saglayici + model + caba secilebilir olmali.
  assert.match(app, /data-rprovider/);
  assert.match(app, /data-rmodel/);
  assert.match(app, /data-reffort/);
  // Kaydetme router'i da gonderir.
  assert.match(app, /JSON\.stringify\(\{ members, coordinator, router, smartModels \}\)/);
});
