import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function safeId(value){const id=String(value||"").replace(/[^a-zA-Z0-9_-]/g,"-").slice(0,120);if(!id)throw new Error("Geçerli koşu kimliği gerekli");return id;}
function hash(content){return crypto.createHash("sha256").update(content).digest("hex");}
function json(value){return JSON.stringify(value,null,2)+"\n";}
function assertNoSymlink(root,target){let current=root;const relative=path.relative(root,target);for(const part of relative.split(path.sep).filter(Boolean)){current=path.join(current,part);if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw new Error(`ArtifactExport symlink yolunu kullanamaz: ${current}`);}}
function atomicWrite(root,file,content){assertNoSymlink(root,path.dirname(file));fs.mkdirSync(path.dirname(file),{recursive:true});assertNoSymlink(root,file);const temp=`${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;fs.writeFileSync(temp,content,{mode:0o600});fs.renameSync(temp,file);}

export function buildArtifactFiles(run,{stage="snapshot"}={}){
  const tasks=(run.tasks||[]).map((task)=>({id:task.id,title:task.title,assignee:task.assignee,assigneeName:task.assigneeName,status:task.status,result:task.result||null,error:task.error||null,contract:task.contract||null,startedAt:task.startedAt||null,endedAt:task.endedAt||null}));
  const files={
    "task-contracts.json":json({schema:"ajan-artifacts/tasks/v1",runId:run.id,tasks}),
    "reviews.json":json({schema:"ajan-artifacts/reviews/v1",runId:run.id,reviews:run.reviews||[]}),
    "integration.json":json({schema:"ajan-artifacts/integration/v1",runId:run.id,mode:run.mode,commitHash:run.commitHash||null,targetBranch:run.targetBranch||null,diffs:run.diffs||[],files:run.files||[],tests:run.tests||[],verify:run.verify||null,evidenceGate:run.evidenceGate||null}),
  };
  if(run.handoff)files["handoff.json"]=json({schema:"ajan-artifacts/handoff/v1",runId:run.id,handoff:run.handoff});
  if(run.report)files["report.md"]=String(run.report).trim()+"\n";
  files["manifest.json"]=json({schema:"ajan-artifacts/manifest/v1",runId:run.id,projectId:run.projectId||null,stage,status:run.status,phase:run.phase,exportedAt:new Date().toISOString(),artifacts:Object.entries(files).map(([name,content])=>({name,bytes:Buffer.byteLength(content),sha256:hash(content)}))});
  return files;
}

export function exportRunArtifacts(projectDir,run,options={}){
  const root=path.resolve(projectDir);if(!fs.existsSync(root)||!fs.statSync(root).isDirectory())throw new Error("ArtifactExport proje dizini bulunamadı");
  const base=path.join(root,".ajan-konseyi"),runDir=path.join(base,"runs",safeId(run.id));assertNoSymlink(root,base);assertNoSymlink(root,runDir);
  const files=buildArtifactFiles(run,options);for(const [name,content] of Object.entries(files))atomicWrite(root,path.join(runDir,name),content);
  return{directory:runDir,relative:path.relative(root,runDir),files:Object.keys(files),manifest:JSON.parse(files["manifest.json"])};
}
