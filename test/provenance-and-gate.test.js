import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { bindTestEvidence, createReviewPacket, isolatedReviewPrompt } from "../src/reviewIsolation.js";
import { normalizeTaskContract } from "../src/taskContract.js";

const contract = () => normalizeTaskContract({
  goal: "Test kanıtı bağlama", nonGoals: [], allowedPaths: ["**"], forbiddenPaths: [],
  risk: "medium", acceptanceCriteria: ["Zorunlu testler geçer"],
  testCommands: ["npm test", "npm run lint"], approvalBoundaries: [],
});

// --- 4) Test kanıtı sözleşme komutuna bağlanır ---
test("çalışmayan zorunlu test sessizce kaybolmaz, ran=false olarak görünür", () => {
  const bound = bindTestEvidence(contract(), [
    { command: "npm test", ok: true, ts: "2026-08-24T01:00:00Z", output: "3 passed" },
  ]);
  assert.equal(bound.length, 2);
  const [t1, t2] = bound;
  assert.deepEqual([t1.command, t1.ran, t1.ok], ["npm test", true, true]);
  assert.deepEqual([t2.command, t2.ran, t2.ok], ["npm run lint", false, false]);
});

test("başarısız çalıştırma ok=false taşır ve en son çalıştırma esas alınır", () => {
  const bound = bindTestEvidence({ testCommands: ["npm test"] }, [
    { command: "npm test", ok: false, ts: "2026-08-24T01:00:00Z", output: "1 failed" },
    { command: "npm test", ok: true, ts: "2026-08-24T02:00:00Z", output: "3 passed" },
  ]);
  assert.equal(bound[0].ran, true);
  assert.equal(bound[0].ok, true, "en son çalıştırma esas alınmadı");
  assert.match(bound[0].output, /3 passed/);
});

test("review paketi zorunlu test bağlamasını taşır ve reviewer'a açıklanır", () => {
  const packet = createReviewPacket({
    taskId: "t1", contract: contract(),
    author: { commit: "abc123", parentCommit: "", tree: "tree1", diff: "diff",
      tests: [{ command: "npm test", ok: true, ts: "2026-08-24T01:00:00Z", output: "ok" }] },
  });
  assert.ok(Array.isArray(packet.author.requiredTests));
  assert.equal(packet.author.requiredTests.length, 2);
  assert.equal(packet.author.requiredTests.find((x) => x.command === "npm run lint").ran, false);
  // Reviewer istemi bu alanın anlamını açıkça söyler
  assert.match(isolatedReviewPrompt(packet, "Denetçi"), /requiredTests/);
  assert.match(isolatedReviewPrompt(packet, "Denetçi"), /ran=false ise o test hiç çalışmamıştır/);
});

// --- 1) Runtime kimlik zarfı ---
test("her çağrı için gerçek sağlayıcı/model zarfı kaydedilir", () => {
  const orch = fs.readFileSync(new URL("../src/orchestrator.js", import.meta.url), "utf8");
  assert.match(orch, /recordEnvelope\(run, \{/);
  assert.match(orch, /requestedProvider: requestedMember\?\.provider/);
  assert.match(orch, /substituted: Boolean\(actualProvider && requestedMember\?\.provider && actualProvider !== requestedMember\.provider\)/);
  // Ortak bağlayıcı gerçekten başka sağlayıcı çalıştırdığında zarfa yazılır
  assert.match(orch, /actualProvider: route\?\.mode === "shared" \? route\.provider : member\.provider/);
});

test("görsel ortak motorla üretildiyse kimlik devri gizlenmez", () => {
  const orch = fs.readFileSync(new URL("../src/orchestrator.js", import.meta.url), "utf8");
  const store = fs.readFileSync(new URL("../src/store.js", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
  assert.match(orch, /run\.imageEngineHandoff\[requestedMember\.id\]/);
  assert.match(orch, /reason: "ortak görsel motoru"/);
  assert.match(store, /engineProvider,\s+\/\/ içeriği fiilen üreten farklı sağlayıcı/);
  // Rozet devri ayrı bir etiketle gösterir
  assert.match(app, /msg\.engineProvider !== provider/);
  assert.match(app, /üretti<\/span>/);
});

// --- 2) EvidenceGate'ten hedef adıma dönüş ---
test("kanıt kapısı takılınca koşu ölmez, yalnız eksik adım yenilenir", () => {
  const orch = fs.readFileSync(new URL("../src/orchestrator.js", import.meta.url), "utf8");
  assert.match(orch, /async repairEvidenceGap\(run, reasons, worktrees/);
  // Görev kimliği sebep metninden çıkarılır ve YALNIZ o görevin review'ı yenilenir
  assert.match(orch, /\/\^\\\[\(\[\\w\.-\]\+\)\\\]\/\.exec/);
  assert.match(orch, /run\.reviews = \(run\.reviews \|\| \[\]\)\.filter\(\(review\) => review\.taskId !== taskId\)/);
  // Zorunlu test ve doğrulayıcı turu ayrı ayrı onarılır
  assert.match(orch, /Zorunlu test kanıtı eksik; test yeniden çalıştırılıyor/);
  assert.match(orch, /run\.verify = null;\s*\n\s*await this\.verifyRound/);
  // Kapı 3 denemeye kadar onarımla tekrarlanır, sonra hata yükselir
  assert.match(orch, /attempt <= 3 && !doneGate/);
  assert.match(orch, /if \(!repaired\) throw error/);
});
