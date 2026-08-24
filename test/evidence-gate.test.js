import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTaskContract } from "../src/taskContract.js";
import { assertEvidenceGate, evaluateEvidenceGate, EvidenceGateError } from "../src/evidenceGate.js";

function fixture(){
  const contract=normalizeTaskContract({goal:"Düzelt",allowedPaths:["src/**"],acceptanceCriteria:["Test geçer"],testCommands:["npm test"],risk:"medium"});
  return {mode:"code",testCommand:"npm test",verify:{verdict:"saglam"},tests:[],tasks:[{id:"t1",status:"done",contract}],reviews:[]};
}

test("review olmadan merge EvidenceGate tarafından engellenir",()=>{
  const run=fixture(),result=evaluateEvidenceGate(run,"merge",{requireTests:false});
  assert.equal(result.passed,false);assert.match(result.reasons.join(" "),/review bulunmuyor/);
  assert.throws(()=>assertEvidenceGate(run,"merge",{requireTests:false}),EvidenceGateError);
  assert.equal(run.evidenceGate.action,"merge");
});

test("review yalnız aynı sözleşme ve immutable kanıtla geçer",()=>{
  const run=fixture(),contract=run.tasks[0].contract;
  run.reviews.push({taskId:"t1",agreement:5,severity:"dusuk",evidencePacket:"packet-sha",reviewedCommit:"commit-sha",reviewedTree:"tree-sha",contractFingerprint:contract.fingerprint});
  assert.equal(evaluateEvidenceGate(run,"merge",{requireTests:false}).passed,true);
  run.reviews[0].contractFingerprint="eski-sozlesme";
  assert.equal(evaluateEvidenceGate(run,"merge",{requireTests:false}).passed,false);
});

test("publish ve done zorunlu test başarılı değilse engellenir",()=>{
  const run=fixture(),contract=run.tasks[0].contract;
  run.reviews.push({taskId:"t1",agreement:4,severity:"orta",evidencePacket:"packet",reviewedCommit:"commit",reviewedTree:"tree",contractFingerprint:contract.fingerprint});
  assert.match(evaluateEvidenceGate(run,"publish").reasons.join(" "),/çalıştırılmadı/);
  run.tests.push({command:"npm test",ok:false,output:"fail"});
  assert.match(evaluateEvidenceGate(run,"done").reasons.join(" "),/başarısız/);
  run.tests.push({command:"npm test",ok:true,output:"pass"});
  assert.equal(evaluateEvidenceGate(run,"publish").passed,true);
  assert.equal(evaluateEvidenceGate(run,"done").passed,true);
});

test("yüksek önem veya başarısız doğrulayıcı kapıyı kapatır",()=>{
  const run=fixture(),contract=run.tasks[0].contract;
  run.reviews.push({taskId:"t1",agreement:5,severity:"yuksek",evidencePacket:"packet",reviewedCommit:"commit",reviewedTree:"tree",contractFingerprint:contract.fingerprint});
  run.verify={verdict:"riskli"};
  const result=evaluateEvidenceGate(run,"merge",{requireTests:false});
  assert.equal(result.passed,false);assert.match(result.reasons.join(" "),/review geçmedi/);assert.match(result.reasons.join(" "),/Doğrulayıcı/);
});

test("riskli ve itirazlı salt-okunur denetim raporu done olabilir ama merge ve publish olamaz",()=>{
  const run=fixture(),contract=run.tasks[0].contract;
  run.mode="discussion";
  run.reviews.push({taskId:"t1",agreement:2,severity:"yuksek",evidencePacket:"packet",reviewedCommit:"commit",reviewedTree:"tree",contractFingerprint:contract.fingerprint});
  run.verify={verdict:"riskli"};
  assert.equal(evaluateEvidenceGate(run,"done",{requireTests:false}).passed,true);
  assert.equal(evaluateEvidenceGate(run,"merge",{requireTests:false}).passed,false);
  assert.equal(evaluateEvidenceGate(run,"publish").passed,false);
});

test("itirazlı review kod koşusunu done aşamasında da engeller",()=>{
  const run=fixture(),contract=run.tasks[0].contract;
  run.reviews.push({taskId:"t1",agreement:3,severity:"yuksek",evidencePacket:"packet",reviewedCommit:"commit",reviewedTree:"tree",contractFingerprint:contract.fingerprint});
  run.tests.push({command:"npm test",ok:true,output:"pass"});
  run.verify={verdict:"riskli"};
  const result=evaluateEvidenceGate(run,"done");
  assert.equal(result.passed,false);
  assert.match(result.reasons.join(" "),/review geçmedi/);
  assert.match(result.reasons.join(" "),/Doğrulayıcı/);
});

test("kod değişikliğiyle geçersizleşen eski review EvidenceGate'i açamaz",()=>{
  const run=fixture(),contract=run.tasks[0].contract;
  run.reviews.push({taskId:"t1",agreement:5,severity:"dusuk",evidencePacket:"eski-paket",reviewedCommit:"eski-commit",contractFingerprint:contract.fingerprint,invalidatedAt:"2026-08-23T00:00:00.000Z"});
  const result=evaluateEvidenceGate(run,"merge",{requireTests:false});assert.equal(result.passed,false);assert.match(result.reasons.join(" "),/review bulunmuyor/);
});
