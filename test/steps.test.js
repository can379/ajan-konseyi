import test from "node:test";
import assert from "node:assert/strict";
import { StepLog, kindForTool, normalizeKind, STEP_KINDS } from "../src/steps.js";

// ---- Sozluk ----

test("arac adlari ortak sozluge dogru esleme yapar", () => {
  const beklenen = {
    Read: "okudu", read_file: "okudu", Glob: "okudu",
    Write: "yazdi", Edit: "yazdi", apply_patch: "yazdi", file_change: "yazdi",
    Bash: "calistirdi", run_command: "calistirdi", command_execution: "calistirdi",
    Grep: "aradi", web_search: "aradi", WebSearch: "aradi",
    WebFetch: "tarayici", browser_navigate: "tarayici",
    Task: "devretti", generate_image: "gorsel",
  };
  for (const [arac, tur] of Object.entries(beklenen)) {
    assert.equal(kindForTool(arac), tur, `${arac} -> ${tur} olmali`);
  }
  // Taninmayan olay DUSURULMEZ: islem'e iner.
  assert.equal(kindForTool("yepyeni_bilinmeyen_arac"), "islem");
  assert.equal(normalizeKind("sacma"), "islem");
  assert.ok(STEP_KINDS.includes("calistirdi"));
});

// ---- StepLog yasam dongusu ----

test("adimlar eklenir, suren adim kapaninca sure kazanir", async () => {
  const log = new StepLog();
  log.open("dusunme", "dusundu", "Akıl yürütüyor");
  log.add("okudu", "index.html", "dosya icerigi...");
  await new Promise((r) => setTimeout(r, 30));
  log.close("dusunme", { title: "Akıl yürüttü" });
  const data = log.finish();
  assert.equal(data.steps.length, 2);
  const dusunme = data.steps[0];
  assert.equal(dusunme.title, "Akıl yürüttü");
  assert.equal(dusunme.status, "ok");
  assert.ok(dusunme.durationMs >= 20, "suren adim sure kazanmali");
  assert.deepEqual(data.counts, { dusundu: 1, okudu: 1 });
});

test("ayni anahtar iki kez acilmaz; finish acik adimlari kapatir", () => {
  const log = new StepLog();
  const a = log.open("x", "calistirdi", "npm test");
  const b = log.open("x", "calistirdi", "npm test");
  assert.equal(a, b, "ayni anahtar tek adim olmali");
  const data = log.finish();
  assert.equal(data.steps.length, 1);
  assert.equal(data.steps[0].status, "ok", "finish acik adimi kapatmali");
});

test("onChange kisilir: her cagri aninda yayim yapmaz", async () => {
  let sayac = 0;
  const log = new StepLog({ onChange: () => { sayac += 1; } });
  for (let i = 0; i < 20; i++) log.add("okudu", `dosya-${i}`);
  assert.equal(sayac, 0, "yayim hemen olmamali (kisitli)");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(sayac, 1, "kisitli tek yayim olmali");
});

test("basarisiz adim durumunu korur ve detay saklanir", () => {
  const log = new StepLog();
  log.add("calistirdi", "npm test", "3 failing", { status: "failed" });
  const data = log.finish();
  assert.equal(data.steps[0].status, "failed");
  assert.equal(data.steps[0].detail, "3 failing");
});

test("bos gunluk finish'te null doner (mesaja gereksiz blok eklenmez)", () => {
  assert.equal(new StepLog().finish(), null);
});

// ---- Baglanti sozlesmeleri ----

test("adaptorler ve orkestrator adim gunlugune bagli", async () => {
  const fs = await import("node:fs");
  const oku = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  assert.match(oku("src/agents/codexAgent.js"), /steps\?\.add\("calistirdi"/);
  assert.match(oku("src/agents/claudeAgent.js"), /kindForTool\(block\.name\)/);
  assert.match(oku("src/agents/antigravityAgent.js"), /opts\.steps\?\.open/);
  assert.match(oku("src/agents/openRouterAgent.js"), /opts\.steps\?\.open\("dusunme"/);
  const orch = oku("src/orchestrator.js");
  assert.match(orch, /new StepLog\(\{ onChange/, "callMember StepLog kurmali");
  assert.match(orch, /steps: stepData/, "memberMsg adimlari mesaja ilistirmeli");
  assert.match(oku("src/store.js"), /streamSteps\(agent, steps\)/);
  assert.match(oku("ui/app.js"), /stepsBlockHTML/, "arayuz katlanir blogu cizmeli");
  assert.match(oku("ui/app.js"), /liveSteps\[ev\.agent\]/, "arayuz canli adimlari almali");
});
