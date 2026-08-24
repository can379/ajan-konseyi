import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Orchestrator } from "../src/orchestrator.js";

function temporaryRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ajan-orchestrator-log-"));
}

test("orkestratör günlüğü yazılır ve günlükleme hatası akışı kesmez", () => {
  const rootDir = temporaryRoot();
  const orch = Object.create(Orchestrator.prototype);
  orch.rootDir = rootDir;

  orch.log("yerel görsel çözümleme atlandı");
  assert.match(fs.readFileSync(path.join(rootDir, "runs", "orchestrator.log"), "utf8"),
    /yerel görsel çözümleme atlandı/);

  assert.doesNotThrow(() => Orchestrator.prototype.log.call({}, "yazılamaz"));
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test("Vision hatası üretilen görseli kaybettirmez ve tanı günlüğe yazılır", async () => {
  const rootDir = temporaryRoot();
  const imagePath = path.join(rootDir, "kedi.png");
  fs.writeFileSync(imagePath, "png");
  let cagrildi = 0;
  const orch = Object.create(Orchestrator.prototype);
  Object.assign(orch, {
    rootDir,
    async analyzeImages() { cagrildi++; throw new Error("xcrun yok"); },
  });

  const kept = await orch.validatedImageAssets("bir kedi görseli oluştur", [
    { kind: "image", mime: "image/png", path: imagePath },
  ]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].path, imagePath);
  assert.equal(cagrildi, 1);
  assert.match(fs.readFileSync(path.join(rootDir, "runs", "orchestrator.log"), "utf8"),
    /kalite doğrulaması atlandı .*xcrun yok/);
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test("üye çağrısı Vision hatasında sürer ve durum rozetini temizler", async () => {
  const rootDir = temporaryRoot();
  const imagePath = path.join(rootDir, "girdi.png");
  fs.writeFileSync(imagePath, "png");
  const statuses = [];
  let cagrildi = 0;
  const member = { id: "anti", name: "Antigravity", provider: "antigravity" };
  const orch = Object.create(Orchestrator.prototype);
  Object.assign(orch, {
    rootDir,
    config: { data: { members: [member] } },
    store: {
      setAgentStatus(id, status) { statuses.push([id, status]); },
      streamProgress() {},
      saveRun() {},
    },
    providers: {
      antigravity: { async send() { return { ok: true, text: "tamam" }; } },
    },
    async analyzeImages() { cagrildi++; throw new Error("Vision kullanılamıyor"); },
  });
  const run = { id: "run-vision", messages: [], usage: {}, stopRequested: false };

  const result = await orch.callMember(run, member, "görseli incele", { images: [imagePath] });
  assert.equal(result.ok, true);
  assert.deepEqual(statuses.at(-1), [member.id, "idle"]);
  assert.equal(cagrildi, 1);
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test("analyzeImages saf geçiştir: yerel Vision hatasını yutmaz", async () => {
  const rootDir = temporaryRoot();
  const orch = Object.create(Orchestrator.prototype);
  orch.rootDir = rootDir;
  const realPath = process.env.PATH;
  process.env.PATH = "";
  try {
    await assert.rejects(() => orch.analyzeImages([path.join(rootDir, "yok.png")]));
  } finally {
    process.env.PATH = realPath;
  }
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test("boş üye yanıtı sessiz balon değil görünür hata olur", () => {
  const rootDir = temporaryRoot();
  const yazilan = [];
  const orch = Object.create(Orchestrator.prototype);
  Object.assign(orch, {
    rootDir,
    store: { addMessage: (_run, msg) => yazilan.push(msg) },
    config: { data: { members: [] }, getProject: () => null },
    memberSignature: () => ({ provider: "openrouter", model: "stealth/ox-alpha" }),
  });
  const run = { id: "run-1", imageEngineHandoff: {} };
  const member = { id: "m-ox-alpha", name: "Ox Alpha", provider: "openrouter", model: "stealth/ox-alpha" };

  const attachments = orch.memberMsg(run, member, "message", "   ");
  assert.deepEqual(attachments, []);
  assert.equal(yazilan.length, 1);
  assert.equal(yazilan[0].from, "sistem");
  assert.equal(yazilan[0].kind, "error");
  assert.match(yazilan[0].content, /Ox Alpha boş yanıt döndürdü/);
  assert.match(fs.readFileSync(path.join(rootDir, "runs", "orchestrator.log"), "utf8"), /boş yanıt döndürdü/);

  orch.memberMsg(run, member, "message", "Gerçek yanıt");
  assert.equal(yazilan.length, 2);
  assert.equal(yazilan[1].from, "m-ox-alpha");
  assert.equal(yazilan[1].content, "Gerçek yanıt");
  fs.rmSync(rootDir, { recursive: true, force: true });
});
