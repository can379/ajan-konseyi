import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendRunEvent, recordTestExecution, testEvidenceFromEvents, verifyRunEventChain } from "../src/runEvents.js";
import { assertProviderAllowed, excludedProvidersFromText, normalizeExcludedProviders, providerAllowed } from "../src/providerPolicy.js";
import { Store } from "../src/store.js";
import { Coordinator } from "../src/coordinator.js";
import { runGoldenSuite } from "../src/evalHarness.js";

test("çalıştırma olayları hash zinciriyle kurcalamayı görünür kılar", () => {
  const run = { events: [] };
  appendRunEvent(run, "provider.finished", { actualProvider: "codex" }, "2026-08-24T10:00:00.000Z");
  recordTestExecution(run, { command: "npm test", ok: true, output: "12/12", taskId: "t1" }, "2026-08-24T10:01:00.000Z");
  assert.equal(verifyRunEventChain(run.events), true);
  assert.deepEqual(testEvidenceFromEvents(run, "t1").map(({ command, ok }) => ({ command, ok })), [{ command: "npm test", ok: true }]);
  run.events[0].detail.actualProvider = "claude";
  assert.equal(verifyRunEventChain(run.events), false);
});

test("sağlayıcı dışlama politikası normalize edilir ve zorunlu uygulanır", () => {
  const excludedProviders = normalizeExcludedProviders(["CLAUDE", "claude", "bilinmeyen"]);
  assert.deepEqual(excludedProviders, ["claude"]);
  assert.equal(providerAllowed({ excludedProviders }, "codex"), true);
  assert.throws(() => assertProviderAllowed({ excludedProviders }, "claude"), { code: "PROVIDER_EXCLUDED" });
});

test("kullanıcının doğal dildeki sağlayıcı dışlaması koşu politikasına dönüşür", () => {
  assert.deepEqual(excludedProvidersFromText("Bu görevde Claude çalışmasın, Ox Alpha kullanma."), ["claude", "openrouter"]);
  assert.deepEqual(excludedProvidersFromText("Claude mimariyi incelesin"), []);
});

test("Store dışlama politikasını koşu oluşturulurken kalıcılaştırır", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ajan-store-"));
  try {
    const store = new Store(root);
    const run = store.createRun({ request: "test", agents: [], excludedProviders: ["Claude", "claude"] });
    assert.deepEqual(run.excludedProviders, ["claude"]);
    assert.deepEqual(run.events, []);
    assert.deepEqual(run.envelopes, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("koordinatör dışlanan sağlayıcı yerine yalnız izinli sağlayıcı seçer", () => {
  const stub = (available = true) => ({ isAvailable: () => available, sessions: new Map() });
  const coordinator = new Coordinator({ setAgentStatus() {} }, { claude: stub(), codex: stub() }, () => ({ provider: "claude" }));
  assert.equal(coordinator.agentFor({ excludedProviders: ["claude"] }), coordinator.providers.codex);
  assert.throws(() => coordinator.agentFor({ excludedProviders: ["claude", "codex"] }), /izinli ve kullanılabilir/);
});

test("golden güvenilirlik değerlendirme seti eksiksiz geçer", () => {
  const cases = JSON.parse(fs.readFileSync(new URL("../evals/golden.json", import.meta.url), "utf8"));
  const result = runGoldenSuite(cases);
  assert.equal(result.failed, 0, JSON.stringify(result.results, null, 2));
  assert.equal(result.passed, cases.length);
});
