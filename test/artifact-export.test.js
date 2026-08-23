import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { exportRunArtifacts } from "../src/artifactExport.js";

function run(){return{id:"run-test-1",projectId:"p1",status:"done",phase:"done",mode:"code",commitHash:"abc",targetBranch:"main",tasks:[{id:"t1",title:"Düzelt",status:"done",contract:{status:"ready",goal:"Hata düzelsin"},result:"tamam"}],handoff:{target:"codex",goal:"devam"},reviews:[{taskId:"t1",agreement:5,evidencePacket:"packet"}],diffs:[{agent:"Codex",branch:"ajan/run/codex",diff:"+fix"}],files:[{path:"src/a.js",change:"M"}],tests:[{command:"npm test",ok:true,output:"pass"}],verify:{verdict:"saglam"},evidenceGate:{passed:true},report:"# Sonuç\nTamamlandı."};}

test("task handoff review integration ve rapor .ajan-konseyi altında ayrı saklanır",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"ajan-export-")),result=exportRunArtifacts(root,run(),{stage:"done"});
  assert.equal(result.relative,path.join(".ajan-konseyi","runs","run-test-1"));
  for(const name of ["task-contracts.json","handoff.json","reviews.json","integration.json","report.md","manifest.json"])assert.ok(fs.existsSync(path.join(result.directory,name)),name);
  const manifest=JSON.parse(fs.readFileSync(path.join(result.directory,"manifest.json"),"utf8"));assert.equal(manifest.stage,"done");
  for(const item of manifest.artifacts){const content=fs.readFileSync(path.join(result.directory,item.name));assert.equal(crypto.createHash("sha256").update(content).digest("hex"),item.sha256);}
  assert.equal(fs.readdirSync(result.directory).some((name)=>name.includes(".tmp-")),false);
});

test("aynı koşu yeniden dışa aktarıldığında atomik olarak güncellenir",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"ajan-export-")),value=run();exportRunArtifacts(root,value,{stage:"review"});value.reviews.push({taskId:"t1",agreement:4,evidencePacket:"packet-2"});
  const result=exportRunArtifacts(root,value,{stage:"integration"}),reviews=JSON.parse(fs.readFileSync(path.join(result.directory,"reviews.json"),"utf8"));assert.equal(reviews.reviews.length,2);assert.equal(result.manifest.stage,"integration");
});

test(".ajan-konseyi symlink ise repo dışına yazılmaz",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"ajan-export-root-")),outside=fs.mkdtempSync(path.join(os.tmpdir(),"ajan-export-outside-"));fs.symlinkSync(outside,path.join(root,".ajan-konseyi"));
  assert.throws(()=>exportRunArtifacts(root,run()),/symlink/);assert.deepEqual(fs.readdirSync(outside),[]);
});

test("geçersiz koşu kimliği güvenli dizin adına çevrilir",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"ajan-export-safe-")),value=run();value.id="../../kaçış";const result=exportRunArtifacts(root,value);assert.ok(result.directory.startsWith(path.join(root,".ajan-konseyi")));assert.equal(fs.existsSync(path.join(root,"..","kaçış")),false);
});
