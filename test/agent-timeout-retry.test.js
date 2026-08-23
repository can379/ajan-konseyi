import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeAgent } from "../src/agents/claudeAgent.js";
import { CodexAgent } from "../src/agents/codexAgent.js";

const store = { setAgentStatus() {}, streamProgress() {} };

for (const [name, Agent] of [["Claude", ClaudeAgent], ["Codex", CodexAgent]]) {
  test(`${name} zaman aşımında modeli değiştirip işi yeniden başlatmaz`, async () => {
    const agent = new Agent(store, process.cwd());
    let calls = 0;
    agent._invoke = async () => {
      calls += 1;
      throw new Error(`${name} çağrısı zaman aşımına uğradı`);
    };

    await assert.rejects(
      agent.invoke("uzun görev", { model: "özel-model" }),
      /zaman aşımına uğradı/
    );
    assert.equal(calls, 1);
  });
}
