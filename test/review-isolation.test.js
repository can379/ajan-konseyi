import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { normalizeTaskContract } from "../src/taskContract.js";
import { createReviewPacket, isolatedReviewPrompt, invalidateStaleReviews } from "../src/reviewIsolation.js";
import { createImmutableSnapshot } from "../src/gitops.js";

const contract=normalizeTaskContract({goal:"Hesaplamayı düzelt",allowedPaths:["src/**"],acceptanceCriteria:["Test geçer"],testCommands:["npm test"],risk:"medium"});

test("review paketi yalnız sözleşme immutable commit diff ve test sonuçlarını taşır",()=>{
  const packet=createReviewPacket({taskId:"t1",contract,author:{commit:"abc123",parentCommit:"abc000",tree:"tree123",diff:"+ düzeltme",tests:[{command:"npm test",ok:true,output:"pass"}]}});
  assert.deepEqual(Object.keys(packet).sort(),["author","contract","fingerprint","schema","taskId"]);
  assert.equal(packet.author.tests[0].ok,true);assert.ok(Object.isFrozen(packet));assert.equal(packet.fingerprint.length,64);
});

test("izole reviewer promptu sohbet geçmişi taşımadan yalnız paketi verir",()=>{
  const packet=createReviewPacket({taskId:"t1",contract,author:{commit:"abc123",diff:"+ güvenli diff",tests:[]}});
  const prompt=isolatedReviewPrompt(packet,"Denetçi");
  assert.match(prompt,/IMMUTABLE REVIEW PACKET/);assert.doesNotMatch(prompt,/GİZLİ SOHBET KANARYASI/);
  assert.doesNotMatch(prompt,/Kullanıcının ana isteği/);
});

test("Git review snapshot'ı çalışma ağacını değiştirmeden sabit commit üretir",async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"ajan-review-"));
  const git=(...args)=>execFileSync("git",args,{cwd:dir,encoding:"utf8",env:{...process.env,GIT_AUTHOR_NAME:"test",GIT_AUTHOR_EMAIL:"test@example.com",GIT_COMMITTER_NAME:"test",GIT_COMMITTER_EMAIL:"test@example.com"}}).trim();
  git("init","-b","main");fs.writeFileSync(path.join(dir,"a.txt"),"ilk\n");git("add","a.txt");git("commit","-m","ilk");
  const branchBefore=git("branch","--show-current"),headBefore=git("rev-parse","HEAD");fs.writeFileSync(path.join(dir,"a.txt"),"son\n");
  const snapshot=await createImmutableSnapshot(dir,"review");
  assert.equal(git("branch","--show-current"),branchBefore);assert.equal(git("rev-parse","HEAD"),headBefore);
  assert.notEqual(snapshot.commit,headBefore);assert.match(snapshot.diff,/\+son/);assert.match(git("status","--short"),/M a\.txt/);
  assert.equal(snapshot.tree,git("rev-parse",`${snapshot.commit}^{tree}`));
});

test("hazır olmayan sözleşme reviewer paketine alınmaz",()=>{
  const draft=normalizeTaskContract({goal:"Eksik"});
  assert.throws(()=>createReviewPacket({taskId:"t",contract:draft,author:{commit:"abc"}}),/hazır TaskContract/);
});

test("tree değişince eski review geçersizleşir, aynı tree geçerli kalır",()=>{
  const reviews=[{taskId:"t1",reviewedTree:"tree-a",agreement:5},{taskId:"t2",reviewedTree:"tree-x",agreement:5}];
  assert.deepEqual(invalidateStaleReviews(reviews,"t1","tree-a"),[]);
  const stale=invalidateStaleReviews(reviews,"t1","tree-b","2026-08-23T00:00:00.000Z");
  assert.equal(stale.length,1);assert.equal(reviews[0].invalidatedAt,"2026-08-23T00:00:00.000Z");assert.equal(reviews[0].supersededByTree,"tree-b");
  assert.equal(reviews[1].invalidatedAt,undefined);
});
