import test from "node:test";
import assert from "node:assert/strict";
import { Orchestrator } from "../src/orchestrator.js";

// callMember'in saglayiciya GONDERDIGI istemi olcer: lean cagrida ortak
// gecmis, yetenek sozlesmesi ve yayin/tarayici yardimlari girmemeli; normal
// cagrida girmeli. (5 KB'lik dosyanin denetimi 73k girdi token yakiyordu.)
async function sentPrompt(opts) {
  let seen = null;
  const member = { id: "m-codex", name: "Codex", provider: "codex", enabled: true };
  const self = {
    rootDir: "/app",
    store: { setAgentStatus() {}, streamProgress() {}, addMessage() {}, updateRun() {} },
    providers: { codex: { sessions: new Map(), send: async (prompt, o) => { seen = { prompt, o }; return { ok: true, text: "ok" }; } } },
    log() {}, accumUsage() {},
    acquireAgentLease: async () => ({ ok: true }), releaseAgentLease() {},
    analyzeImages: async () => "", browserBridge: { issueAgentToken: () => "TOKEN" },
    enforceEvidenceGate() { return true; }, recordEnvelope() {},
    referencedImages: () => [], sessionKeyFor: () => "k",
    sharedConversationContext: () => "ESKI SOHBET SATIRLARI",
    trackSessionContext() {},
  };
  const run = { id: "r", kind: "chat", mode: "auto", projectDir: "/proje", messages: [], usage: {}, tasks: [] };
  await Orchestrator.prototype.callMember.call(self, run, member, "İNCELEME GÖREVİ", opts);
  return seen;
}

test("lean cagrida gecmis, sozlesme ve yardim bloklari isteme girmez", async () => {
  const { prompt, o } = await sentPrompt({ label: "ikili inceleme", lean: true, fresh: true });
  assert.match(prompt, /İNCELEME GÖREVİ/);
  assert.doesNotMatch(prompt, /ORTAK SOHBET GEÇMİŞİ|ESKI SOHBET/);
  assert.doesNotMatch(prompt, /YETENEK SÖZLEŞMESİ/);
  assert.doesNotMatch(prompt, /YAYIN ARACI|TARAYICI ARACI/);
  assert.equal(o.fresh, true, "denetci taze oturumla kosmali");
  assert.equal(o.cwd, "/proje", "dar baglam cwd'yi KAPATMAMALI: denetci kod okur");
});

test("normal cagrida baglam bloklari yerinde durur", async () => {
  const { prompt } = await sentPrompt({ label: "doğrudan mesaj" });
  assert.match(prompt, /YETENEK SÖZLEŞMESİ/);
  assert.match(prompt, /ORTAK SOHBET GEÇMİŞİ/);
  assert.match(prompt, /YAYIN ARACI/);
});

test("ikili inceleme lean ve taze kosacak sekilde bagli", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../src/orchestrator.js", import.meta.url), "utf8");
  const blok = src.slice(src.indexOf('label: "ikili inceleme"'), src.indexOf('label: "ikili inceleme"') + 400);
  assert.match(blok, /lean: true/);
  assert.match(blok, /fresh: true/);
  assert.match(src, /TUTUMLU ÇALIŞ/, "denetciye az-dosya-oku talimati verilmeli");
});
