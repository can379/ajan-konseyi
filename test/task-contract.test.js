import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeTaskContract } from "../src/taskContract.js";
import { WorkspaceState } from "../src/workspaceState.js";

test("görev sözleşmesi kapsam, risk, kriter ve komutları normalleştirir", () => {
  const contract = normalizeTaskContract({
    goal:"Ödeme ekranını düzelt",
    nonGoals:["Yeni ödeme sağlayıcısı ekleme"],
    allowedPaths:["./src/payments/**", "src/payments/**"],
    forbiddenPaths:[".env"], risk:"high",
    acceptanceCriteria:["Mevcut ödeme tamamlanır"],
    testCommands:["npm test"], approvalBoundaries:["Yayın öncesi onay al"],
  });
  assert.equal(contract.status, "ready");
  assert.deepEqual(contract.allowedPaths, ["src/payments/**"]);
  assert.equal(contract.fingerprint.length, 64);
});

test("eksik sözleşme taslak kalır ve proje dışı yolu reddeder", () => {
  const draft = normalizeTaskContract({ goal:"Kısmi hedef" });
  assert.equal(draft.status, "draft");
  assert.match(draft.errors.join(" "), /kabul kriteri/i);
  assert.throws(() => normalizeTaskContract({ goal:"x", allowedPaths:["../secret"] }), /Proje dışına/);
});

test("sözleşme görevle kalıcı saklanır ve revizyonlanır", () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"ajan-contract-"));
  const state=new WorkspaceState(root),task=state.task({title:"Sözleşmeli görev"});
  assert.equal(task.contract.status,"draft");
  const saved=state.setTaskContract(task.id,{goal:"Tamamla",allowedPaths:["src/**"],acceptanceCriteria:["Test geçer"],testCommands:["npm test"],risk:"low"});
  assert.equal(saved.status,"ready");
  assert.equal(saved.revision,2);
  const loaded=new WorkspaceState(root).data.tasks.find((item)=>item.id===task.id);
  assert.equal(loaded.contract.fingerprint,saved.fingerprint);
  assert.ok(state.data.audit.some((item)=>item.action==="task.contract.update"));
});
