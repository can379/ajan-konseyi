import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_CATALOG, TIER_MAP } from "../src/models.js";
import { AntigravityAgent } from "../src/agents/antigravityAgent.js";
import { ClaudeAgent } from "../src/agents/claudeAgent.js";
import { Orchestrator } from "../src/orchestrator.js";

const AGY_MODELS = [
  "gemini-3.7-flash-high", "gemini-3.7-flash-medium", "gemini-3.7-flash-low",
  "gemini-3.6-flash-high", "gemini-3.6-flash-medium", "gemini-3.6-flash-low",
  "gemini-3.5-flash-high", "gemini-3.5-flash-medium", "gemini-3.5-flash-low",
  "gemini-3.1-pro-high", "gemini-3.1-pro-low", "claude-sonnet-4-6",
  "claude-opus-4-6-thinking", "gpt-oss-120b-medium",
];

function antigravityAgent() {
  const agent = Object.create(AntigravityAgent.prototype);
  Object.assign(agent, {
    rootDir: process.cwd(), bin: "agy", _cliReady: false,
    getSession: () => null, setSession() {}, getModel: () => "", getEffort: () => "",
    progress() {}, updateBridgeStatus() {}, log() {},
  });
  return agent;
}

test("Antigravity kataloğu agy model kimliklerinin 14'ünü sunar", () => {
  const values = MODEL_CATALOG.antigravity.filter((item) => item.value).map((item) => item.value);
  assert.deepEqual([...values].sort(), [...AGY_MODELS].sort());
  assert.equal(TIER_MAP.antigravity.strong, "gemini-3.1-pro-high");
});

test("Türkçe Antigravity çabası agy --effort argümanına çevrilir", async () => {
  const agent = antigravityAgent();
  agent.spawnCollect = async (_bin, args, _cwd, _timeout, onLine) => {
    assert.deepEqual(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2), ["--effort", "medium"]);
    onLine(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "hazır" } }));
    return { code: 0, timedOut: false, stdout: "", stderr: "" };
  };
  await agent._invoke("iş", { effort: "orta" });
});

test("kademe son ekli model seçiliyken Antigravity --effort göndermez", async () => {
  const agent = antigravityAgent();
  agent.spawnCollect = async (_bin, args, _cwd, _timeout, onLine) => {
    assert.ok(args.includes("--model"));
    assert.ok(!args.includes("--effort"));
    onLine(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "hazır" } }));
    return { code: 0, timedOut: false, stdout: "", stderr: "" };
  };
  await agent._invoke("iş", { model: "gemini-3.7-flash-low", effort: "yuksek" });
});

test("kademe son eki olmayan model Antigravity --effort değerini korur", async () => {
  const agent = antigravityAgent();
  agent.spawnCollect = async (_bin, args, _cwd, _timeout, onLine) => {
    assert.deepEqual(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2), ["--effort", "high"]);
    onLine(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "hazır" } }));
    return { code: 0, timedOut: false, stdout: "", stderr: "" };
  };
  await agent._invoke("iş", { model: "claude-sonnet-4-6", effort: "yuksek" });
});

test("otomatik Antigravity modelinde kullanıcı çabası tier modelinden önceliklidir", async () => {
  const member = { id: "anti", name: "Antigravity", provider: "antigravity", model: "", effort: "yuksek" };
  let sentOpts;
  const orch = Object.create(Orchestrator.prototype);
  Object.assign(orch, {
    rootDir: process.cwd(),
    config: { data: { members: [member] } },
    store: { setAgentStatus() {} },
    providers: { antigravity: { async send(_prompt, opts) { sentOpts = opts; return { ok: true, text: "hazır" }; } } },
    accumUsage() {},
  });
  const run = { id: "run-effort", messages: [], usage: {}, stopRequested: false };
  await orch.callMember(run, member, "iş", { tierModel: "gemini-3.7-flash-high" });
  assert.equal(sentOpts.model, "");
  assert.equal(sentOpts.effort, "yuksek");
});

test("bilinmeyen Antigravity modeli çıktı yoksa varsayılanla yalnız bir kez denenir", async () => {
  const agent = antigravityAgent();
  const models = [];
  agent._invoke = async (_prompt, opts) => {
    models.push(opts.model);
    if (models.length === 1) {
      const err = new Error("unknown model bad-model");
      err.noOutput = true;
      throw err;
    }
    return { ok: true, text: "hazır" };
  };
  assert.equal((await agent.invoke("iş", { model: "bad-model" })).ok, true);
  assert.deepEqual(models, ["bad-model", ""]);
});

test("'model x is not recognized' hata biçimi varsayılan model fallback'ini tetikler", async () => {
  const agent = antigravityAgent();
  const models = [];
  agent._invoke = async (_prompt, opts) => {
    models.push(opts.model);
    if (models.length === 1) {
      const err = new Error("model bad-model is not recognized as a known model");
      err.noOutput = true;
      throw err;
    }
    return { ok: true, text: "hazır" };
  };
  await agent.invoke("iş", { model: "bad-model" });
  assert.deepEqual(models, ["bad-model", ""]);
});

test("çıktı üretmiş Antigravity model hatası yeniden çağrı başlatmaz", async () => {
  const agent = antigravityAgent();
  let calls = 0;
  agent._invoke = async () => {
    calls++;
    const err = new Error("unknown model bad-model");
    err.noOutput = false;
    throw err;
  };
  await assert.rejects(() => agent.invoke("iş", { model: "bad-model" }), /unknown model/);
  assert.equal(calls, 1);
});

test("Claude çabası --effort ve eski token ortam değişkenine birlikte aktarılır", async () => {
  const agent = Object.create(ClaudeAgent.prototype);
  Object.assign(agent, {
    rootDir: process.cwd(), bin: "claude", getSession: () => null,
    getModel: () => "", getEffort: () => "", progress() {}, setSession() {},
  });
  agent.spawnCollect = async (_bin, args, _stdin, _cwd, _timeout, onLine, env) => {
    assert.deepEqual(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2), ["--effort", "high"]);
    assert.equal(env.MAX_THINKING_TOKENS, "16384");
    onLine(JSON.stringify({ type: "result", result: "hazır", usage: {} }));
    return { code: 0, timedOut: false, stdout: "", stderr: "" };
  };
  assert.equal((await agent._invoke("iş", { effort: "yuksek" })).text, "hazır");
});
