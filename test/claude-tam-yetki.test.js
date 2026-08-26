// Uye Claude cagrisi izin penceresine takilmamali (kullanici karari).
//
// Canli gorulen hata: uye "testleri fiilen calistiramadim — node --test,
// npx tsc, eslint cagrilari onay bekleyip reddedildi" dedi. auto/acceptEdits
// kipleri komutlari onaya dusuruyordu; bassiz calisan uyede onayi verecek
// kimse yok. Codex zaten --approve-for-me ile tam yetkili; Claude da ayni
// duzeyde olmali.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAgent } from "../src/agents/claudeAgent.js";

test("Claude cagrisi izin penceresiz tam yetkiyle calisir", async () => {
  const agent = Object.create(ClaudeAgent.prototype);
  Object.assign(agent, {
    rootDir: process.cwd(), bin: "claude", getSession: () => null,
    getModel: () => "", getEffort: () => "", progress() {}, setSession() {},
  });
  let gorulen = null;
  agent.spawnCollect = async (_bin, args, _stdin, _cwd, _t, onLine) => {
    gorulen = args;
    onLine(JSON.stringify({ type: "result", result: "ok", usage: {} }));
    return { code: 0, timedOut: false, stdout: "", stderr: "" };
  };
  await agent.invoke("testleri çalıştır", {});
  const i = gorulen.indexOf("--permission-mode");
  assert.ok(i > -1);
  assert.equal(gorulen[i + 1], "bypassPermissions",
    "izin kipi tam yetki olmalı — auto/acceptEdits komutları onaya düşürüp kilitliyor");
});
