import test from "node:test";
import assert from "node:assert/strict";
import { Orchestrator } from "../src/orchestrator.js";

// resolveMemberCwd'yi birim testi kilitliyor; bu test callMember'in onu
// GERCEKTEN uyguladigini ve sonucu saglayici cagrisina gecirdigini olcer.
// Boylece karar dogru olsa bile baglanmamis olma ihtimali kapanir.
async function invokedOpts(run, opts) {
  let seen = null;
  const member = { id: "m-codex", name: "Codex", provider: "codex", enabled: true };
  const self = {
    rootDir: "/app",
    store: {
      setAgentStatus() {}, streamProgress() {}, addMessage() {}, updateRun() {},
    },
    providers: {
      codex: {
        sessions: new Map(),
        send: async (_prompt, callOpts) => { seen = callOpts; return { ok: true, text: "ok" }; },
      },
    },
    log() {},
    accumUsage() {},
    acquireAgentLease: async () => ({ ok: true }),
    releaseAgentLease() {},
    analyzeImages: async () => "",
    browserBridge: null,
    enforceEvidenceGate() { return true; },
    recordEnvelope() {},
    referencedImages: () => [],
    sessionKeyFor: () => "k",
    sharedConversationContext: () => "",
    trackSessionContext() {},
  };
  await Orchestrator.prototype.callMember.call(self, run, member, "selam", opts);
  return seen;
}

const RUN = (extra = {}) => ({
  id: "run-1", kind: "chat", mode: "auto", projectDir: "/proje",
  messages: [], usage: {}, tasks: [], ...extra,
});

test("cwd verilmeyen cagri saglayiciya proje dizini ile gider", async () => {
  const seen = await invokedOpts(RUN(), { label: "doğrudan mesaj" });
  assert.equal(seen.cwd, "/proje");
});

test("acikca verilen cwd saglayiciya degismeden gider", async () => {
  const seen = await invokedOpts(RUN(), { label: "görev", cwd: "/proje/wt" });
  assert.equal(seen.cwd, "/proje/wt");
});

test("izole inceleme saglayiciya cwd'siz gider", async () => {
  const seen = await invokedOpts(RUN(), { label: "inceleme", isolated: true });
  assert.equal(seen.cwd, undefined);
});

test("kod modunda kopyasiz gorev saglayiciya cwd'siz gider", async () => {
  const seen = await invokedOpts(RUN({ mode: "code" }), { label: "görev", noProjectCwd: true });
  assert.equal(seen.cwd, undefined);
});
