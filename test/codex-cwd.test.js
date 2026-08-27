import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CodexAgent } from "../src/agents/codexAgent.js";

function readRoots(args) {
  const entry = args.find((a) => typeof a === "string" && a.startsWith("sandbox_workspace_write.writable_roots="));
  return entry ? JSON.parse(entry.slice(entry.indexOf("=") + 1)) : [];
}

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

// TAM YETKİ (kullanıcı kararı): taze ve devam oturumu aynı bayrağı kullanır;
// onay penceresi/sandbox yok. Önceki on-request onay, başsız üyede komutu
// kilitliyordu.
test("resume tam yetki bayragiyla calisir, onay mekanizmasi kalmaz", async () => {
  const { agent, calls } = harness({ resume: true });
  await agent._invoke("selam", { sessionKey: "s1", cwd: "/tmp/proje-c" });
  const config = calls[0].args.join(" ");
  assert.match(config, /bypass-approvals-and-sandbox/);
  assert.doesNotMatch(config, /approval_policy/);
  assert.doesNotMatch(config, /approve-for-me/);
});

// Codex'in workspace-write kum havuzu ".git" altina yazmayi varsayilan olarak
// reddeder, bu da "git apply" ve "git commit" islemlerini
// "Operation not permitted" ile dusurur. Git dizinleri yazilabilir koklere
// eklenmezse ajan projeye kurulum yapamaz.
test("git dizinleri yazilabilir koklere eklenir", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "codex-repo-"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  const { agent, calls } = harness({ resume: true });
  await agent._invoke("selam", { sessionKey: "s1", cwd: repo });
  const roots = readRoots(calls[0].args);
  assert.ok(roots.includes(repo), "calisma dizini yazilabilir olmali");
  assert.ok(roots.some((r) => r.endsWith(".git")), `git dizini eklenmeli: ${JSON.stringify(roots)}`);
});

// Ayri calisma kopyasinda ".git" bir dosyadir ve ana depoyu gosterir; ajanin
// git islemi yapabilmesi icin ORTAK git dizini de yazilabilir olmalidir.
test("worktree icin ortak git dizini de eklenir", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "codex-wt-"));
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "a");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "ilk"]);
  const wt = path.join(repo, "..", path.basename(repo) + "-wt");
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", wt, "-b", "dal"]);

  const { agent, calls } = harness({ resume: true });
  await agent._invoke("selam", { sessionKey: "s1", cwd: wt });
  const roots = readRoots(calls[0].args);
  assert.ok(roots.some((r) => r.includes("worktrees")), `worktree git dizini eklenmeli: ${JSON.stringify(roots)}`);
  assert.ok(roots.some((r) => r === path.join(fs.realpathSync(repo), ".git") || r.endsWith(`${path.basename(repo)}/.git`)),
    `ortak git dizini eklenmeli: ${JSON.stringify(roots)}`);
});

test("cwd verilmezse kok dizine dusulur", async () => {
  const { agent, calls, rootDir } = harness({ resume: true });
  await agent._invoke("selam", { sessionKey: "s1" });
  assert.equal(calls[0].cwd, undefined, "cwd yoksa spawnCollect varsayilana duser");
  assert.equal(readRoots(calls[0].args).length, 0, "proje yoksa yazilabilir kok zorlanmamali");
  assert.ok(fs.existsSync(rootDir));
});
