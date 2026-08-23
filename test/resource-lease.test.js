import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireResourceLease, renewResourceLease, releaseResourceLease, sweepExpiredLeases, ResourceLeaseError } from "../src/resourceLease.js";
import { WorkspaceState } from "../src/workspaceState.js";

const owner=(agentId,taskId="t1")=>({runId:"run-1",taskId,agentId,label:agentId});

test("aynı portta iki farklı ajan yazma sahipliği alamaz",()=>{
  const first=acquireResourceLease([],{type:"port",resource:"5173",owner:owner("codex")},1_000);
  assert.throws(()=>acquireResourceLease(first.leases,{type:"port",resource:"5173",owner:owner("claude")},2_000),ResourceLeaseError);
  assert.equal(first.lease.key,"port:5173");
});

test("aynı sahip lease'i yeniler, token olmadan yenileme ve bırakma yapılamaz",()=>{
  const first=acquireResourceLease([],{type:"db",resource:"postgres:main",owner:owner("codex"),ttlMs:10_000},1_000);
  const again=acquireResourceLease(first.leases,{type:"db",resource:"postgres:main",owner:owner("codex"),ttlMs:20_000},2_000);
  assert.equal(again.lease.id,first.lease.id);
  assert.throws(()=>renewResourceLease(again.leases,again.lease.id,"yanlış",10_000,3_000),/token/);
  const renewed=renewResourceLease(again.leases,again.lease.id,again.lease.token,30_000,3_000);
  assert.equal(+new Date(renewed.lease.expiresAt),33_000);
  assert.throws(()=>releaseResourceLease(renewed.leases,renewed.lease.id,"yanlış"),/token/);
  assert.equal(releaseResourceLease(renewed.leases,renewed.lease.id,renewed.lease.token).leases.length,0);
});

test("süresi dolan lease yeni ajanın kaynağı almasını engellemez",()=>{
  const first=acquireResourceLease([],{type:"cache",resource:"build",owner:owner("codex"),ttlMs:5_000},1_000);
  const swept=sweepExpiredLeases(first.leases,7_000);assert.equal(swept.active.length,0);assert.equal(swept.expired.length,1);
  const second=acquireResourceLease(first.leases,{type:"cache",resource:"build",owner:owner("claude")},7_000);assert.equal(second.lease.owner.agentId,"claude");
});

test("WorkspaceState kaynak sahipliğini ve denetim izini kalıcı saklar",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"ajan-lease-")),state=new WorkspaceState(root);
  const lease=state.acquireLease({type:"container",resource:"worker-1",owner:owner("codex")});
  assert.equal(new WorkspaceState(root).activeLeases()[0].id,lease.id);
  state.releaseLease(lease.id,lease.token);assert.equal(state.activeLeases().length,0);
  assert.ok(state.data.audit.some((item)=>item.action==="lease.acquire"));assert.ok(state.data.audit.some((item)=>item.action==="lease.release"));
});
