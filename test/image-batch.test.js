import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Orchestrator } from "../src/orchestrator.js";

test("toplu görseller konseye dağıtılır, ortak Codex motorunda ve sınırlı paralellikle üretilir", async () => {
  const root = fs.mkdtempSync(path.join("/private/tmp", "ajan-image-batch-"));
  fs.mkdirSync(path.join(root, "generated"));
  const members = [
    { id:"claude", name:"Claude", provider:"claude" },
    { id:"codex", name:"Codex", provider:"codex" },
    { id:"anti", name:"Antigravity", provider:"antigravity" },
  ];
  const updates=[]; let active=0; let peak=0; const providers=[]; const generators=[];
  const store = {
    updateRun(run, patch={}) { Object.assign(run, patch); updates.push(run.phase); },
    addMessage(run, msg) { run.messages.push({ id:String(run.messages.length), ...msg }); },
    setAgentStatus() {}, streamProgress() {}, saveRun() {}, runsDir:path.join(root,"runs"),
  };
  const orch = Object.create(Orchestrator.prototype);
  Object.assign(orch, { rootDir:root, store, config:{ data:{ members } }, providers:{},
    persistSessions() {},
    async callMember(_run, member, prompt) {
      providers.push(member.provider);
      if (!prompt.includes("Dosyayı")) return { ok:true, text:`fotogerçekçi görsel oluştur: ${prompt.slice(-20)}` };
      generators.push(member.provider);
      active++; peak=Math.max(peak,active); await new Promise((r)=>setTimeout(r,10));
      const file=path.join(root,"generated",`${providers.length}.png`);
      fs.writeFileSync(file, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64")); active--;
      return { ok:true, text:file };
    },
  });
  const run={ id:"run-batch", agents:members.map((m)=>m.id), messages:[], tasks:[], stopRequested:false, projectDir:null, usage:{} };
  orch.startImageBatch(run, { prompts:Array.from({length:9},(_,i)=>`Görsel ${i}`), concurrency:3 });
  while (run.turnActive) await new Promise((r)=>setTimeout(r,5));
  assert.equal(run.batch.completed,9);
  assert.equal(run.batch.failed,0);
  assert.equal(run.status,"done");
  assert.ok(peak <= 3);
  assert.deepEqual(run.tasks.slice(0,3).map((t)=>t.assignee), ["claude","codex","anti"]);
  assert.deepEqual(generators, Array(9).fill("codex"));
  fs.rmSync(root,{recursive:true,force:true});
});
