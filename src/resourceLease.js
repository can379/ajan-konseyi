import crypto from "node:crypto";

export const RESOURCE_TYPES=new Set(["port","container","db","cache","external-service"]);
export class ResourceLeaseError extends Error{constructor(message,conflict=null){super(message);this.name="ResourceLeaseError";this.conflict=conflict;}}

function value(input,max=500){return String(input??"").trim().slice(0,max);}
function ttl(valueMs){return Math.max(5_000,Math.min(Number(valueMs)||15*60_000,24*60*60_000));}

export function normalizeLeaseRequest(input={}){
  const type=value(input.type,40),resource=value(input.resource);
  if(!RESOURCE_TYPES.has(type))throw new ResourceLeaseError(`Desteklenmeyen kaynak türü: ${type||"boş"}`);
  if(!resource)throw new ResourceLeaseError("Kaynak kimliği gerekli");
  if(type==="port"&&(!/^\d+$/.test(resource)||Number(resource)<1||Number(resource)>65535))throw new ResourceLeaseError("Port 1-65535 arasında olmalı");
  const owner={runId:value(input.owner?.runId,120),taskId:value(input.owner?.taskId,120),agentId:value(input.owner?.agentId,120),label:value(input.owner?.label,200)};
  if(!owner.runId&&!owner.taskId&&!owner.agentId)throw new ResourceLeaseError("Lease sahibi gerekli");
  return {type,resource,key:`${type}:${resource}`,owner,ttlMs:ttl(input.ttlMs),metadata:input.metadata&&typeof input.metadata==="object"?structuredClone(input.metadata):{}};
}

export function sweepExpiredLeases(leases,now=Date.now()){const expired=[],active=[];for(const lease of leases||[]){(+new Date(lease.expiresAt)<=now?expired:active).push(lease);}return{active,expired};}

export function acquireResourceLease(leases,input,now=Date.now()){
  const request=normalizeLeaseRequest(input),swept=sweepExpiredLeases(leases,now),sameOwner=(lease)=>lease.owner?.runId===request.owner.runId&&lease.owner?.taskId===request.owner.taskId&&lease.owner?.agentId===request.owner.agentId;
  const conflict=swept.active.find((lease)=>lease.key===request.key&&!sameOwner(lease));
  if(conflict)throw new ResourceLeaseError(`${request.key} kaynağı ${conflict.owner?.label||conflict.owner?.agentId||conflict.owner?.runId} tarafından kullanılıyor`,conflict);
  let lease=swept.active.find((item)=>item.key===request.key&&sameOwner(item));
  if(lease){lease.expiresAt=new Date(now+request.ttlMs).toISOString();lease.renewedAt=new Date(now).toISOString();lease.metadata=request.metadata;}
  else lease={id:crypto.randomUUID(),token:crypto.randomBytes(24).toString("hex"),...request,acquiredAt:new Date(now).toISOString(),expiresAt:new Date(now+request.ttlMs).toISOString()};
  return {leases:[...swept.active.filter((item)=>item.id!==lease.id),lease],lease,expired:swept.expired};
}

export function renewResourceLease(leases,id,tokenValue,ttlMs,now=Date.now()){
  const swept=sweepExpiredLeases(leases,now),lease=swept.active.find((item)=>item.id===id);
  if(!lease)throw new ResourceLeaseError("Lease bulunamadı veya süresi doldu");
  if(lease.token!==tokenValue)throw new ResourceLeaseError("Lease token geçersiz");
  lease.expiresAt=new Date(now+ttl(ttlMs)).toISOString();lease.renewedAt=new Date(now).toISOString();return{leases:swept.active,lease,expired:swept.expired};
}

export function releaseResourceLease(leases,id,tokenValue,{force=false}={}){
  const lease=(leases||[]).find((item)=>item.id===id);if(!lease)throw new ResourceLeaseError("Lease bulunamadı");
  if(!force&&lease.token!==tokenValue)throw new ResourceLeaseError("Lease token geçersiz");
  return{leases:(leases||[]).filter((item)=>item.id!==id),lease};
}
