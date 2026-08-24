import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexAgent } from "../src/agents/codexAgent.js";

// Codex alt sureci gercekten calistirilmaz: spawnCollect degistirilip
// _invoke'un ona ne gecirdigi olculur. Regresyon tam burada yasiyordu.
function harness({ resume = false } = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cwd-"));
  fs.mkdirSync(path.join(rootDir, "runs"), { recursive: true });
  const store = { setAgentStatus() {}, streamProgress() {}, log() {} };
  const agent = new CodexAgent(store, rootDir);
  agent.progress = () => {};
  agent.log = () => {};
  const calls = [];
  agent.spawnCollect = async (bin, args, stdin, timeoutMs, onLine, sessionKey, cwd) => {
    calls.push({ args, cwd });
    // _invoke son mesaji "-o" dosyasindan okur.
    const outIndex = args.indexOf("-o");
    if (outIndex >= 0) fs.writeFileSync(args[outIndex + 1], "tamam");
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  if (resume) agent.sessions.set("s1", "thread-abc");
  return { agent, calls, rootDir };
}

test("taze oturumda calisma dizini alt surece verilir", async () => {
  const { agent, calls } = harness();
  await agent._invoke("selam", { sessionKey: "s1", cwd: "/tmp/proje-a" });
  assert.equal(calls[0].cwd, "/tmp/proje-a", "spawn cwd proje dizini olmali");
  assert.ok(calls[0].args.includes("-C"), "taze oturumda -C de verilir");
});

// Asil regresyon: "exec resume" -C bayragini kabul etmez. Alt surece cwd
// gecirilmezse Codex sunucunun kendi dizinine duser ve workspace-write
// sandbox'i proje dizinine yazmayi "Operation not permitted" ile reddeder.
test("resume edilen oturumda da calisma dizini projeye baglanir", async () => {
  const { agent, calls } = harness({ resume: true });
  await agent._invoke("selam", { sessionKey: "s1", cwd: "/tmp/proje-b" });
  const call = calls[0];
  assert.ok(call.args.includes("resume"), "resume yolu kullanilmali");
  assert.ok(!call.args.includes("-C"), "resume -C kabul etmez");
  assert.equal(call.cwd, "/tmp/proje-b", "cwd surec seviyesinde verilmeli");
});

test("resume sandbox yazilabilir koku proje dizinine baglanir", async () => {
  const { agent, calls } = harness({ resume: true });
  await agent._invoke("selam", { sessionKey: "s1", cwd: "/tmp/proje-c" });
  const config = calls[0].args.join(" ");
  assert.match(config, /sandbox_mode="workspace-write"/);
  assert.match(config, /sandbox_workspace_write\.writable_roots=\["\/tmp\/proje-c"\]/);
});

test("cwd verilmezse kok dizine dusulur", async () => {
  const { agent, calls, rootDir } = harness({ resume: true });
  await agent._invoke("selam", { sessionKey: "s1" });
  assert.equal(calls[0].cwd, undefined, "cwd yoksa spawnCollect varsayilana duser");
  assert.ok(!calls[0].args.join(" ").includes("writable_roots"),
    "proje yoksa yazilabilir kok zorlanmamali");
  assert.ok(fs.existsSync(rootDir));
});
