import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BaseAgent } from "../src/agents/base.js";

const store = {
  setAgentStatus() {},
  streamProgress() {},
};

class ControlledAgent extends BaseAgent {
  constructor(rootDir) {
    super("controlled", store, rootDir);
    this.calls = [];
  }
  invoke(prompt) {
    this.calls.push(prompt);
    if (prompt === "hang") return new Promise(() => {});
    return Promise.resolve({ ok: true, text: prompt });
  }
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ajan-watchdog-"));
  fs.mkdirSync(path.join(dir, "runs"));
  return dir;
}

test("watchdog sonuçlanmayan sağlayıcı çağrısını terminal duruma getirir", async () => {
  const agent = new ControlledAgent(fixture());
  const result = await agent.send("hang", { sessionKey: "run#member", timeoutMs: 10 });
  assert.equal(result.ok, false);
  assert.match(result.error, /sonuçlanmadı/);
  assert.equal(agent.busyCount, 0);
});

test("stop aynı oturumdaki eski kuyruğu iptal eder; yeni görev hemen çalışır", async () => {
  const agent = new ControlledAgent(fixture());
  const first = agent.send("hang", { sessionKey: "run#member", timeoutMs: 10_000 });
  await new Promise((resolve) => setImmediate(resolve));
  agent.stop("run");
  const second = await agent.send("fresh", { sessionKey: "run#member", timeoutMs: 100 });
  const stopped = await first;
  assert.equal(stopped.cancelled, true);
  assert.deepEqual(second, { ok: true, text: "fresh" });
  assert.deepEqual(agent.calls, ["hang", "fresh"]);
});
