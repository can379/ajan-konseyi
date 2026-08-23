import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { draftTaskContract, normalizeTaskContract } from "./taskContract.js";
import { acquireResourceLease, renewResourceLease, releaseResourceLease, sweepExpiredLeases } from "./resourceLease.js";

export class WorkspaceState {
  constructor(root){this.file=path.join(root,"workspace-state.json");this.data={version:1,tasks:[],audit:[],permissions:{},trash:[],memoryPins:{},skills:[],leases:[]};this.load();}
  load(){try{this.data={...this.data,...JSON.parse(fs.readFileSync(this.file,"utf8"))};}catch{}this.save();}
  save(){const tmp=this.file+".tmp";fs.writeFileSync(tmp,JSON.stringify(this.data,null,2));fs.renameSync(tmp,this.file);}
  record(action,detail={},projectId=null){this.data.audit.push({id:crypto.randomUUID(),ts:new Date().toISOString(),action,projectId,detail});this.data.audit=this.data.audit.slice(-3000);this.save();}
  permission(projectId,capability){return this.data.permissions[projectId]?.[capability]||"ask";}
  setPermissions(projectId,value){this.data.permissions[projectId]={...(this.data.permissions[projectId]||{}),...value};this.record("permissions.update",value,projectId);return this.data.permissions[projectId];}
  task(input){const task={id:crypto.randomUUID(),createdAt:new Date().toISOString(),status:"queued",progress:0,...input};if(!task.contract)task.contract=draftTaskContract(task.title||"");this.data.tasks.unshift(task);this.save();return task;}
  patchTask(id,patch){const task=this.data.tasks.find(x=>x.id===id);if(!task)return null;Object.assign(task,patch,{updatedAt:new Date().toISOString()});this.save();return task;}
  setTaskContract(id,input){const task=this.data.tasks.find(x=>x.id===id);if(!task)return null;task.contract=normalizeTaskContract(input,task.contract);task.updatedAt=new Date().toISOString();this.record("task.contract.update",{taskId:id,revision:task.contract.revision,status:task.contract.status,fingerprint:task.contract.fingerprint},task.projectId||null);return task.contract;}
  activeLeases(){const swept=sweepExpiredLeases(this.data.leases);if(swept.expired.length){this.data.leases=swept.active;this.record("lease.expire",{leaseIds:swept.expired.map(x=>x.id)});}return this.data.leases;}
  acquireLease(input){const result=acquireResourceLease(this.data.leases,input);this.data.leases=result.leases;this.record("lease.acquire",{leaseId:result.lease.id,key:result.lease.key,owner:result.lease.owner});return result.lease;}
  renewLease(id,token,ttlMs){const result=renewResourceLease(this.data.leases,id,token,ttlMs);this.data.leases=result.leases;this.record("lease.renew",{leaseId:id,key:result.lease.key});return result.lease;}
  releaseLease(id,token,options){const result=releaseResourceLease(this.data.leases,id,token,options);this.data.leases=result.leases;this.record("lease.release",{leaseId:id,key:result.lease.key,owner:result.lease.owner});return result.lease;}
  syncRun(run){let task=this.data.tasks.find(x=>x.runId===run.id);if(!task)task=this.task({runId:run.id,title:run.title||run.request||"Görev",projectId:run.projectId||null,kind:run.kind||"run"});task.status=run.status==="idle"?"done":run.status;task.phase=run.phase;task.progress=run.batch?.total?Math.round((run.batch.completed||0)/run.batch.total*100):(run.status==="done"?100:task.progress||0);task.error=run.error||null;if(run.tasks?.length===1&&run.tasks[0].contract)task.contract=run.tasks[0].contract;task.updatedAt=new Date().toISOString();this.save();return task;}
  saveSkill(input){
    const now=new Date().toISOString();
    let skill=input.id?this.data.skills.find(x=>x.id===input.id):null;
    if(skill)Object.assign(skill,input,{updatedAt:now});
    else{skill={id:crypto.randomUUID(),name:String(input.name||"Yeni yetenek"),version:String(input.version||"1.0.0"),instructions:String(input.instructions||""),command:String(input.command||""),enabledProjects:[],createdAt:now,...input};this.data.skills.unshift(skill);}
    this.record("skill.save",{skillId:skill.id,name:skill.name});
    return skill;
  }
  enableSkill(id,projectId,enabled){
    const skill=this.data.skills.find(x=>x.id===id);if(!skill)return null;
    const values=new Set(skill.enabledProjects||[]);enabled?values.add(projectId):values.delete(projectId);skill.enabledProjects=[...values];skill.updatedAt=new Date().toISOString();
    this.record("skill.toggle",{skillId:id,enabled:!!enabled},projectId);return skill;
  }
  public(){this.activeLeases();return structuredClone(this.data);}
}
