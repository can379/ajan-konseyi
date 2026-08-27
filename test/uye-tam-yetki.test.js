// TUM uyeler izin penceresine takilmadan calisir (kullanici karari:
// "sadece claude degil hepsi tam yetki olsun").
//
// Uye BASSIZ calisir; onay penceresine dusen her komut kayiptir. Canli
// gorulen hata: "node --test / npx tsc / eslint cagrilari onay bekleyip
// reddedildi". Bu dosya uc saglayicinin da tam yetki bayragini sabitler.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const oku = (yol) => fs.readFileSync(new URL(`../${yol}`, import.meta.url), "utf8");

test("Codex taze VE devam oturumu tam yetki bayragiyla calisir", async () => {
  const { CodexAgent } = await import("../src/agents/codexAgent.js");
  const agent = Object.create(CodexAgent.prototype);
  Object.assign(agent, {
    rootDir: "/tmp", bin: "codex", getSession: () => "thread-123",
    getModel: () => "", getEffort: () => "", progress() {}, setSession() {},
    log() {},
  });
  const gorulen = [];
  // Codex imzası: spawnCollect(bin, args, prompt, timeoutMs, onLine, sessionKey, cwd)
  agent.spawnCollect = async (_bin, args, _prompt, _t, onLine) => {
    gorulen.push(args);
    onLine?.(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }));
    return { code: 0, timedOut: false, stdout: "", stderr: "", lastMessage: "ok" };
  };
  // Devam oturumu (getSession bir oturum donduruyor)
  await agent.invoke("testleri çalıştır", {});
  // Taze oturum
  await agent.invoke("testleri çalıştır", { fresh: true });
  for (const args of gorulen) {
    assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"),
      `tam yetki bayrağı eksik: ${args.join(" ")}`);
    // Eski onay mekanizmalari geri gelmemeli — onay isteyen her komut
    // bassiz oturumda kaybolur.
    assert.ok(!args.includes("--approve-for-me"), "eski onay bayrağı kalmamalı");
    assert.ok(!args.some((a) => /approval_policy/.test(a)), "onay politikası config'i kalmamalı");
  }
});

test("Antigravity izin atlama bayragiyla calisir", () => {
  assert.match(oku("src/agents/antigravityAgent.js"), /--dangerously-skip-permissions/);
});

test("Claude izin kipinde onay penceresi yok", () => {
  // claude-tam-yetki.test.js davranisi argv duzeyinde dogrular; burada
  // kaynak duzeyinde sabitlenir ki uc saglayici tek bakista denetlensin.
  const claude = oku("src/agents/claudeAgent.js");
  assert.match(claude, /"--permission-mode", "bypassPermissions"/);
  // args.push ile GERCEKTEN onayli kip verilmemeli (yorumda gecebilir).
  assert.ok(!/push\("--permission-mode", opts\.codeMode \? "acceptEdits"/.test(claude),
    "onaylı kip geri gelmemeli");
});
