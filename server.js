import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./src/store.js";
import { Orchestrator } from "./src/orchestrator.js";
import { Config, ROLES } from "./src/config.js";
import { MODEL_CATALOG, EFFORT_LEVELS } from "./src/models.js";
import { detectMedia, MAX_UPLOAD_BYTES, PROVIDER_CAPABILITIES } from "./src/media.js";
import { discoverCapabilities } from "./src/capabilityDiscovery.js";
import { conversationTitle } from "./src/util.js";
import { BrowserBridge } from "./src/browserBridge.js";
import { WorkspaceState } from "./src/workspaceState.js";
import { exportRunArtifacts } from "./src/artifactExport.js";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
const execP = promisify(execFile);
const HOME = os.homedir();

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Kaynaklar uygulama paketinde salt okunur olabilir. Kullanıcıya ait sohbet,
// ayar, yükleme ve günlükler ayrı bir yazılabilir veri dizininde tutulur.
// Geliştirici modunda env verilmezse mevcut davranış korunur.
const DATA_ROOT = path.resolve(process.env.AJAN_KONSEYI_DATA_DIR || ROOT);
const PORT = process.env.PORT || 4780;
const UI_TOKEN = process.env.AJAN_UI_TOKEN || "";
const BRIDGE_TOKEN = process.env.AJAN_BROWSER_BRIDGE_TOKEN || "";

fs.mkdirSync(DATA_ROOT, { recursive: true });
const store = new Store(DATA_ROOT);
const config = new Config(DATA_ROOT);
const orch = new Orchestrator(store, DATA_ROOT, config);
const browserBridge = new BrowserBridge({ bridgeToken:BRIDGE_TOKEN });
const workspaceState=new WorkspaceState(DATA_ROOT);
store.on("event",event=>{if(event.runId){const run=store.getRun(event.runId);if(run)workspaceState.syncRun(run);}});
orch.browserBridge = browserBridge;
orch.resourceLeases = workspaceState;
orch.artifactExporter=(run,stage="snapshot")=>{const project=config.getProject(run.projectId);if(!project?.artifactExport)return null;const result=exportRunArtifacts(project.path,run,{stage});workspaceState.record("artifact.export",{runId:run.id,stage,relative:result.relative,files:result.files},project.id);return result;};

// Kalıcı proje kabukları: cwd, export'lar ve uzun çalışan süreçler komutlar
// arasında korunur. Çıktı artımlı okunur; masaüstü kapanınca temizlenir.
const terminalSessions = new Map();
const devSessions = new Map();
const checkpointsDir=path.join(DATA_ROOT,"checkpoints");fs.mkdirSync(checkpointsDir,{recursive:true});
function detectDevCommand(project){
  if(project.devCommand)return project.devCommand;
  try{const pkg=JSON.parse(fs.readFileSync(path.join(project.path,"package.json"),"utf8"));for(const name of ["dev","start","serve"]){if(pkg.scripts?.[name])return `npm run ${name}`;}}catch{}
  if(fs.existsSync(path.join(project.path,"vite.config.js"))||fs.existsSync(path.join(project.path,"vite.config.ts")))return "npx vite";
  return "";
}
function startDevSession(project){
  const existing=devSessions.get(project.id);if(existing?.alive)return existing;
  const command=detectDevCommand(project);if(!command)throw new Error("Geliştirme komutu bulunamadı; proje ayarlarından belirtin");
  const child=spawn("/bin/zsh",["-lc",command],{cwd:project.path,stdio:["ignore","pipe","pipe"],env:{...process.env,BROWSER:"none",HOST:"127.0.0.1"}});
  const session={projectId:project.id,command,child,alive:true,output:"",url:null,startedAt:new Date().toISOString()};
  const append=(data)=>{const text=data.toString();session.output=(session.output+text).slice(-200000);const match=text.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/i)||session.output.match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/i);if(match&&!session.lease){try{session.lease=workspaceState.acquireLease({type:"port",resource:match[1],owner:{runId:`dev:${project.id}`,agentId:"dev-server",label:`${project.name} geliştirme sunucusu`},ttlMs:24*60*60_000,metadata:{projectId:project.id,command}});session.url=`http://127.0.0.1:${match[1]}`;}catch(error){session.output+=`\n[kaynak çakışması: ${error.message}]\n`;session.error=error.message;child.kill("SIGTERM");}}};
  child.stdout.on("data",append);child.stderr.on("data",append);child.on("close",code=>{session.alive=false;session.exitCode=code;if(session.lease){try{workspaceState.releaseLease(session.lease.id,session.lease.token);}catch{}session.lease=null;}});devSessions.set(project.id,session);return session;
}
function devView(s){return s?{projectId:s.projectId,command:s.command,alive:s.alive,url:s.url,output:s.output.slice(-12000),startedAt:s.startedAt,exitCode:s.exitCode}:null;}
function copyCheckpoint(source,target){fs.cpSync(source,target,{recursive:true,filter:(src)=>!src.split(path.sep).some((part)=>[".git","node_modules","dist","build",".next"].includes(part))});}
function createTerminalSession(project) {
  const id = crypto.randomUUID();
  const child = spawn("/bin/zsh", ["-l"], { cwd:project.path, stdio:["pipe","pipe","pipe"], env:{ ...process.env, TERM:"xterm-256color", FORCE_COLOR:"0" } });
  const session = { id, projectId:project.id, cwd:project.path, child, output:"", alive:true };
  const append = (d) => { session.output += d.toString(); if(session.output.length>4e6) session.output=session.output.slice(-3e6); };
  child.stdout.on("data",append); child.stderr.on("data",append);
  child.on("close",(code)=>{ session.alive=false; append(`\n[kabuk kapandı: ${code ?? "?"}]\n`); });
  terminalSessions.set(id,session);
  child.stdin.write("unsetopt zle 2>/dev/null\n");
  return session;
}
function terminalView(session, from=0) {
  const start=Math.max(0,Number(from)||0);
  return { sessionId:session.id, projectId:session.projectId, cwd:session.cwd, output:session.output.slice(start), cursor:session.output.length, alive:session.alive };
}

// 30 günden eski ve hiçbir koşuda referans edilmeyen yüklemeleri temizle.
function cleanupUploads() {
  const dir = path.join(DATA_ROOT, "uploads"); if (!fs.existsSync(dir)) return;
  const referenced = new Set();
  for (const run of Object.values(store.runs)) {
    for (const a of [...(run.attachments || []), ...(run.messages || []).flatMap((m) => m.attachments || [])]) if (a.path) referenced.add(path.resolve(a.path));
  }
  const cutoff = Date.now() - 30 * 86400_000;
  for (const name of fs.readdirSync(dir)) { const file=path.join(dir,name); try { const st=fs.statSync(file); if(st.isFile()&&st.mtimeMs<cutoff&&!referenced.has(path.resolve(file))) fs.unlinkSync(file); } catch {} }
}
cleanupUploads();

function isWithin(parent, candidate) {
  const rel = path.relative(path.resolve(parent), path.resolve(candidate));
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}

// ---- SSE aboneleri ----
const sseClients = new Set();
store.on("event", (ev) => {
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of sseClients) res.write(data);
});

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(s);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 140e6) req.destroy(); });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function bearer(req) { return String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""); }
function uiAuthorized(req) { return Boolean(UI_TOKEN && req.headers["x-ajan-ui-token"] === UI_TOKEN); }

const MIME = { ".html": "text/html", ".htm":"text/html", ".js": "text/javascript", ".css": "text/css", ".md": "text/markdown", ".svg":"image/svg+xml", ".json":"application/json" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  try {
    // ---- Statik UI ----
    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      return serveFile(res, path.join(ROOT, "ui", "index.html"));
    }
    if (req.method === "GET" && (p === "/app.js" || p === "/style.css" || p === "/studio.css")) {
      return serveFile(res, path.join(ROOT, "ui", p));
    }

    // ---- SSE olay akışı ----
    if (req.method === "GET" && p === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    // ---- Durum ----
    if (req.method === "GET" && p === "/api/state") {
      return json(res, 200, {
        ...store.snapshot(url.searchParams.get("run")),
        config: config.data,
        roles: ROLES,
        models: MODEL_CATALOG,
        efforts: EFFORT_LEVELS,
        home: HOME,
        capabilities: PROVIDER_CAPABILITIES,
        workspaceState:workspaceState.public(),
      });
    }
    if(req.method==="GET"&&p==="/api/workspace")return json(res,200,workspaceState.public());
    if(req.method==="GET"&&p==="/api/workspace/leases")return json(res,200,{leases:workspaceState.activeLeases()});
    if(req.method==="POST"&&p==="/api/workspace/leases"){const body=await readBody(req);try{return json(res,201,workspaceState.acquireLease(body));}catch(error){return json(res,409,{error:error.message,conflict:error.conflict||null});}}
    const leaseApi=p.match(/^\/api\/workspace\/leases\/([\w-]+)$/);
    if(req.method==="PATCH"&&leaseApi){const body=await readBody(req);try{return json(res,200,workspaceState.renewLease(leaseApi[1],String(body.token||""),body.ttlMs));}catch(error){return json(res,403,{error:error.message});}}
    if(req.method==="DELETE"&&leaseApi){const body=await readBody(req);try{return json(res,200,{released:workspaceState.releaseLease(leaseApi[1],String(body.token||""))});}catch(error){return json(res,403,{error:error.message});}}
    const artifactExportApi=p.match(/^\/api\/runs\/([\w-]+)\/artifact-export$/);
    if(req.method==="POST"&&artifactExportApi){const run=store.getRun(artifactExportApi[1]);if(!run)return json(res,404,{error:"Koşu bulunamadı"});const project=config.getProject(run.projectId);if(!project)return json(res,400,{error:"Koşuya bağlı proje bulunamadı"});try{const result=exportRunArtifacts(project.path,run,{stage:"manual"});workspaceState.record("artifact.export",{runId:run.id,stage:"manual",relative:result.relative,files:result.files},project.id);return json(res,200,result);}catch(error){return json(res,400,{error:error.message});}}
    if(req.method==="POST"&&p==="/api/workspace/permissions"){const body=await readBody(req);return json(res,200,workspaceState.setPermissions(String(body.projectId||"global"),body.permissions||{}));}
    if(req.method==="GET"&&p==="/api/workspace/audit")return json(res,200,{audit:workspaceState.data.audit});
    if(req.method==="POST"&&p==="/api/workspace/skills"){const body=await readBody(req);return json(res,200,workspaceState.saveSkill(body));}
    const skillApi=p.match(/^\/api\/workspace\/skills\/([\w-]+)(?:\/(enable))?$/);
    if(req.method==="POST"&&skillApi?.[2]){const body=await readBody(req),skill=workspaceState.enableSkill(skillApi[1],String(body.projectId||"global"),body.enabled!==false);return json(res,skill?200:404,skill||{error:"Yetenek bulunamadı"});}
    if(req.method==="DELETE"&&skillApi?.[1]&&!skillApi[2]){const index=workspaceState.data.skills.findIndex(x=>x.id===skillApi[1]);if(index<0)return json(res,404,{error:"Yetenek bulunamadı"});const [skill]=workspaceState.data.skills.splice(index,1);workspaceState.record("skill.delete",{skillId:skill.id,name:skill.name});return json(res,200,{ok:true});}
    const workspaceTask=p.match(/^\/api\/workspace\/tasks(?:\/([\w-]+))?$/);
    if(req.method==="POST"&&workspaceTask&&!workspaceTask[1]){const body=await readBody(req);return json(res,200,workspaceState.task({title:String(body.title||"Görev"),projectId:body.projectId||null,kind:String(body.kind||"general")}));}
    if(req.method==="PATCH"&&workspaceTask?.[1]){const body=await readBody(req),task=workspaceState.patchTask(workspaceTask[1],body);return json(res,task?200:404,task||{error:"Görev bulunamadı"});}
    const taskContractApi=p.match(/^\/api\/workspace\/tasks\/([\w-]+)\/contract$/);
    if(req.method==="GET"&&taskContractApi){const task=workspaceState.data.tasks.find(x=>x.id===taskContractApi[1]);return json(res,task?200:404,task?.contract||{error:"Görev bulunamadı"});}
    if(req.method==="PUT"&&taskContractApi){const body=await readBody(req);try{const contract=workspaceState.setTaskContract(taskContractApi[1],body);return json(res,contract?200:404,contract||{error:"Görev bulunamadı"});}catch(error){return json(res,400,{error:error.message});}}
    const taskAction=p.match(/^\/api\/workspace\/tasks\/([\w-]+)\/(pause|resume|retry|cancel)$/);
    if(req.method==="POST"&&taskAction){const task=workspaceState.data.tasks.find(x=>x.id===taskAction[1]);if(!task)return json(res,404,{error:"Görev bulunamadı"});const run=task.runId?store.getRun(task.runId):null,action=taskAction[2];try{if(action==="pause"&&run){orch.stopRun(run);workspaceState.patchTask(task.id,{status:"paused"});}if((action==="resume"||action==="retry")&&run){orch.resumeRun(run);workspaceState.patchTask(task.id,{status:"running"});}if(action==="cancel"){if(run)orch.stopRun(run);workspaceState.patchTask(task.id,{status:"cancelled"});}return json(res,200,{ok:true});}catch(error){return json(res,400,{error:error.message});}}
    if (req.method === "GET" && p === "/api/project-file") {
      const project=config.getProject(url.searchParams.get("projectId"));
      const requested=path.resolve(String(url.searchParams.get("path")||""));
      if(!project||!isWithin(path.resolve(project.path),requested)||!fs.existsSync(requested)||!fs.statSync(requested).isFile()) return json(res,404,{error:"Proje dosyası bulunamadı"});
      return serveFile(res,requested);
    }
    const fileApi=p.match(/^\/api\/projects\/([\w-]+)\/files\/(tree|read|write|create|rename|search)$/);
    if(fileApi){const project=config.getProject(fileApi[1]);if(!project)return json(res,404,{error:"Proje bulunamadı"});const action=fileApi[2],root=path.resolve(project.path);const safe=(v)=>{const target=path.resolve(root,String(v||"."));if(!isWithin(root,target))throw new Error("Proje dışına erişilemez");return target;};try{
      if(req.method==="GET"&&action==="tree"){const walk=(dir,d=0)=>d>5?[]:fs.readdirSync(dir,{withFileTypes:true}).filter(e=>!e.name.startsWith(".")&&!["node_modules","dist","build",".next"].includes(e.name)).slice(0,300).map(e=>{const full=path.join(dir,e.name);return{path:path.relative(root,full),name:e.name,kind:e.isDirectory()?"dir":"file",children:e.isDirectory()?walk(full,d+1):undefined};});return json(res,200,{tree:walk(root)});}
      if(req.method==="GET"&&action==="read"){const file=safe(url.searchParams.get("path")),content=fs.readFileSync(file,"utf8");if(content.length>2e6)throw new Error("Dosya çok büyük");return json(res,200,{path:path.relative(root,file),content});}
      if(req.method==="POST"&&action==="write"){const body=await readBody(req),file=safe(body.path),content=String(body.content??"");if(content.length>2e6)throw new Error("İçerik çok büyük");fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);workspaceState.record("file.write",{path:body.path},project.id);return json(res,200,{ok:true});}
      if(req.method==="POST"&&action==="create"){const body=await readBody(req),target=safe(body.path);if(fs.existsSync(target))throw new Error("Zaten var");fs.mkdirSync(path.dirname(target),{recursive:true});body.kind==="dir"?fs.mkdirSync(target):fs.writeFileSync(target,"");return json(res,200,{ok:true});}
      if(req.method==="POST"&&action==="rename"){const body=await readBody(req),from=safe(body.from),to=safe(body.to);if(fs.existsSync(to))throw new Error("Hedef zaten var");fs.renameSync(from,to);return json(res,200,{ok:true});}
      if(req.method==="GET"&&action==="search"){const q=String(url.searchParams.get("q")||"").toLowerCase(),results=[];const scan=(dir,d=0)=>{if(d>5||results.length>=100)return;for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(e.name.startsWith(".")||["node_modules","dist","build",".next"].includes(e.name))continue;const full=path.join(dir,e.name);if(e.isDirectory())scan(full,d+1);else if(e.name.toLowerCase().includes(q))results.push({path:path.relative(root,full),name:e.name});}};if(q.length>1)scan(root);return json(res,200,{results});}
    }catch(error){return json(res,400,{error:error.message});}}
    const gitCenter=p.match(/^\/api\/projects\/([\w-]+)\/git\/(status|diff|log|test|commit)$/);
    if(gitCenter){const project=config.getProject(gitCenter[1]);if(!project)return json(res,404,{error:"Proje bulunamadı"});const action=gitCenter[2];try{
      if(req.method==="GET"&&action==="status"){const [{stdout:branch},{stdout:status},{stdout:aheadBehind}]=await Promise.all([execP("git",["branch","--show-current"],{cwd:project.path}),execP("git",["status","--short"],{cwd:project.path}),execP("git",["rev-list","--left-right","--count","HEAD...@{upstream}"],{cwd:project.path}).catch(()=>({stdout:"0\t0"}))]);return json(res,200,{branch:branch.trim()||"HEAD",files:status.split("\n").filter(Boolean).map(line=>({code:line.slice(0,2),path:line.slice(3)})),ahead:Number(aheadBehind.trim().split(/\s+/)[0])||0,behind:Number(aheadBehind.trim().split(/\s+/)[1])||0});}
      if(req.method==="GET"&&action==="diff"){const staged=url.searchParams.get("staged")==="1",{stdout}=await execP("git",["diff",...(staged?["--cached"]:[]),"--no-ext-diff","--unified=3"],{cwd:project.path,maxBuffer:10*1024*1024});return json(res,200,{diff:stdout});}
      if(req.method==="GET"&&action==="log"){const {stdout}=await execP("git",["log","-20","--date=iso-strict","--pretty=format:%H%x09%h%x09%ad%x09%s"],{cwd:project.path});return json(res,200,{commits:stdout.split("\n").filter(Boolean).map(line=>{const [hash,short,date,...subject]=line.split("\t");return{hash,short,date,subject:subject.join("\t")};})});}
      if(req.method==="POST"&&action==="test"){const body=await readBody(req),command=String(body.command||config.getProject(project.id)?.testCommand||"npm test").trim();if(!command)return json(res,400,{error:"Test komutu gerekli"});const task=workspaceState.task({title:`Test: ${command}`,projectId:project.id,kind:"test",status:"running"});try{const {stdout,stderr}=await execP("/bin/zsh",["-lc",command],{cwd:project.path,timeout:10*60*1000,maxBuffer:20*1024*1024});workspaceState.patchTask(task.id,{status:"done",progress:100});workspaceState.record("test.run",{command,ok:true},project.id);return json(res,200,{ok:true,command,output:stdout+stderr});}catch(error){workspaceState.patchTask(task.id,{status:"failed",error:error.message});workspaceState.record("test.run",{command,ok:false},project.id);return json(res,200,{ok:false,command,output:String(error.stdout||"")+String(error.stderr||error.message)});}}
      if(req.method==="POST"&&action==="commit"){const body=await readBody(req),message=String(body.message||"").trim();if(!message)return json(res,400,{error:"Commit mesajı gerekli"});await execP("git",["add","-A"],{cwd:project.path});const {stdout}=await execP("git",["commit","-m",message],{cwd:project.path});workspaceState.record("git.commit",{message},project.id);return json(res,200,{ok:true,output:stdout});}
    }catch(error){return json(res,400,{error:String(error.stderr||error.message)});}}
    if (req.method === "GET" && p === "/api/capabilities") {
      const capabilities=structuredClone(await discoverCapabilities(url.searchParams.get("refresh")==="1"));
      const browser=browserBridge.status();
      const browserStatus=!browser.connected?"needs-bridge":(browser.shared?"shared-controlled":"agent-open");
      for(const provider of Object.values(capabilities.providers||{}))provider.native.browser=browserStatus;
      return json(res,200,capabilities);
    }
    if(req.method==="GET"&&p==="/api/browser/status")return json(res,200,browserBridge.status());
    if(req.method==="POST"&&p==="/api/browser/share"){if(!uiAuthorized(req))return json(res,403,{error:"Yetkisiz arayüz isteği"});try{return json(res,200,browserBridge.grant(await readBody(req)));}catch(error){return json(res,400,{error:error.message});}}
    if(req.method==="POST"&&p==="/api/browser/stop"){if(!uiAuthorized(req))return json(res,403,{error:"Yetkisiz arayüz isteği"});browserBridge.stop();return json(res,200,{ok:true});}
    if(req.method==="POST"&&p==="/api/browser/approve"){if(!uiAuthorized(req))return json(res,403,{error:"Yetkisiz arayüz isteği"});const body=await readBody(req);return json(res,browserBridge.approve(body.id,Boolean(body.approved))?200:404,{ok:true});}
    if(req.method==="POST"&&p==="/api/browser/action"){try{const body=await readBody(req);return json(res,200,await browserBridge.request({token:bearer(req),action:body.action,payload:body.payload}));}catch(error){const status=error.code==="RATE_LIMIT"?429:error.code==="POLICY"?400:error.code==="AUTH"?403:409;return json(res,status,{error:error.message});}}
    if(req.method==="GET"&&p==="/api/browser/bridge/command"){const command=browserBridge.nextCommand(bearer(req));if(command===undefined)return json(res,403,{error:"Yetkisiz köprü"});return json(res,200,{command});}
    if(req.method==="POST"&&p==="/api/browser/bridge/result"){const body=await readBody(req);const ok=browserBridge.complete(bearer(req),body.id,body.result,body.error);return json(res,ok?200:403,{ok});}

    // ---- Kalıcı proje terminali ----
    if (req.method === "POST" && p === "/api/terminal/sessions") {
      const body = await readBody(req);
      const project = config.getProject(body.projectId || config.data.activeProject);
      if (!project || !fs.existsSync(project.path)) return json(res,400,{error:"Önce geçerli bir proje seçin"});
      const existing=[...terminalSessions.values()].find((s)=>s.projectId===project.id&&s.alive);
      return json(res,200,terminalView(existing||createTerminalSession(project)));
    }
    const terminalMatch=p.match(/^\/api\/terminal\/sessions\/([\w-]+)(?:\/(write|interrupt|close))?$/);
    if (terminalMatch) {
      const session=terminalSessions.get(terminalMatch[1]);
      if (!session) return json(res,404,{error:"Terminal oturumu bulunamadı"});
      const action=terminalMatch[2];
      if(req.method==="GET"&&!action) return json(res,200,terminalView(session,url.searchParams.get("from")));
      if(req.method==="POST"&&action==="write") {
        const body=await readBody(req); const input=String(body.input||"");
        if(input.length>8000) return json(res,400,{error:"Komut çok uzun"});
        if(!session.alive) return json(res,409,{error:"Terminal kapalı"});
        session.child.stdin.write(input.endsWith("\n")?input:input+"\n");
        return json(res,200,terminalView(session,body.from));
      }
      if(req.method==="POST"&&action==="interrupt") { if(session.alive) session.child.kill("SIGINT"); return json(res,200,{ok:true}); }
      if(req.method==="POST"&&action==="close") { if(session.alive) session.child.kill("SIGTERM"); terminalSessions.delete(session.id); return json(res,200,{ok:true}); }
    }

    // Geriye dönük tek-komut uç noktası.
    if (req.method === "POST" && p === "/api/terminal") {
      const body = await readBody(req);
      const command = String(body.command || "").trim();
      if (!command) return json(res, 400, { error: "Komut boş olamaz" });
      if (command.length > 8000) return json(res, 400, { error: "Komut çok uzun" });
      const project = config.getProject(body.projectId || config.data.activeProject);
      if (!project || !fs.existsSync(project.path)) {
        return json(res, 400, { error: "Önce geçerli bir proje seçin" });
      }
      try {
        const result = await execP("/bin/zsh", ["-lc", command], {
          cwd: project.path,
          timeout: 120_000,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, TERM: "xterm-256color", FORCE_COLOR: "0" },
        });
        return json(res, 200, { cwd: project.path, stdout: result.stdout, stderr: result.stderr, code: 0 });
      } catch (e) {
        return json(res, 200, {
          cwd: project.path,
          stdout: String(e.stdout || ""), stderr: String(e.stderr || e.message || e),
          code: Number.isInteger(e.code) ? e.code : 1,
        });
      }
    }


    const runDetail = p.match(/^\/api\/runs\/([\w-]+)$/);
    if (req.method === "GET" && runDetail) {
      const run = store.getRun(runDetail[1]);
      if (!run) return json(res, 404, { error: "Koşu bulunamadı" });
      return json(res, 200, run);
    }
    if(req.method==="PATCH"&&runDetail){const run=store.getRun(runDetail[1]);if(!run)return json(res,404,{error:"Sohbet bulunamadı"});const body=await readBody(req);if("title" in body)run.title=String(body.title||"Yeni sohbet").trim().slice(0,80);if("pinned" in body)run.pinned=!!body.pinned;if("archived" in body)run.archived=!!body.archived;if("tags" in body)run.tags=Array.isArray(body.tags)?body.tags.map(x=>String(x).trim()).filter(Boolean).slice(0,12):[];if("deletedAt" in body)run.deletedAt=body.deletedAt?new Date().toISOString():null;if("projectId" in body){const project=body.projectId?config.getProject(body.projectId):null;run.projectId=project?.id||null;run.projectDir=project?.path||null;}store.updateRun(run);workspaceState.record("chat.update",{runId:run.id,fields:Object.keys(body)},run.projectId);return json(res,200,run);}
    const exportMatch=p.match(/^\/api\/runs\/([\w-]+)\/export$/);
    if(req.method==="GET"&&exportMatch){const run=store.getRun(exportMatch[1]);if(!run)return json(res,404,{error:"Sohbet bulunamadı"});res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Content-Disposition":`attachment; filename="${run.id}.json"`});return res.end(JSON.stringify({format:"ajan-chat-v1",run},null,2));}
    if(req.method==="POST"&&p==="/api/runs/import"){const body=await readBody(req),source=body.run;if(body.format!=="ajan-chat-v1"||!source)return json(res,400,{error:"Geçersiz sohbet dosyası"});const project=body.projectId?config.getProject(body.projectId):null,run=store.createRun({kind:"chat",request:String(source.request||"İçe aktarılan sohbet"),mode:source.mode,agents:source.agents,projectId:project?.id||null,projectDir:project?.path||null,attachments:[],maxDebateRounds:source.maxDebateRounds});run.status="idle";run.phase="idle";run.title=String(source.title||"İçe aktarılan sohbet").slice(0,80);run.messages=Array.isArray(source.messages)?source.messages.slice(-500):[];run.tags=Array.isArray(source.tags)?source.tags:[];store.updateRun(run);return json(res,200,{runId:run.id});}
    const transferMatch=p.match(/^\/api\/runs\/([\w-]+)\/transfer$/);
    if(req.method==="POST"&&transferMatch){const source=store.getRun(transferMatch[1]);const body=await readBody(req);if(!source)return json(res,404,{error:"Sohbet bulunamadı"});const project=body.projectId?config.getProject(body.projectId):config.getProject(source.projectId),done=(source.tasks||[]).filter(t=>t.status==="done").map(t=>t.title),remaining=(source.tasks||[]).filter(t=>t.status!=="done").map(t=>t.title),files=[...new Set((source.files||[]).map(f=>f.path))].slice(0,50);const run=store.createRun({kind:"chat",request:source.request,mode:source.mode,agents:source.agents,projectId:project?.id||null,projectDir:project?.path||null,attachments:[],maxDebateRounds:source.maxDebateRounds});run.status="idle";run.phase="idle";run.title=`${source.title||source.request} · devir`;run.messages=(source.messages||[]).slice(-30).map(m=>({...m}));run.handoff={sourceRunId:source.id,target:String(body.target||"konsey"),goal:String(body.goal||source.request),completed:done,remaining,decisions:(source.decisions||[]).slice(-10),files,createdAt:new Date().toISOString()};store.addMessage(run,{from:"sistem",kind:"info",content:`Yapılandırılmış devir paketi\nHedef: ${run.handoff.target}\nAmaç: ${run.handoff.goal}\nTamamlananlar: ${done.join(", ")||"-"}\nKalan işler: ${remaining.join(", ")||"-"}\nDosyalar: ${files.join(", ")||"-"}`});store.updateRun(run);orch.exportArtifacts(run,"handoff");return json(res,200,{runId:run.id,handoff:run.handoff});}
    const commentMatch=p.match(/^\/api\/runs\/([\w-]+)\/diff-comments$/);
    if(req.method==="POST"&&commentMatch){const run=store.getRun(commentMatch[1]);const body=await readBody(req);if(!run)return json(res,404,{error:"Koşu bulunamadı"});run.diffComments??=[];run.diffComments.push({id:crypto.randomUUID(),file:String(body.file||""),line:Number(body.line||0),body:String(body.body||"").slice(0,2000),createdAt:new Date().toISOString()});store.updateRun(run);return json(res,200,{ok:true});}

    const feedbackMatch = p.match(/^\/api\/runs\/([\w-]+)\/messages\/([\w-]+)\/feedback$/);
    if (req.method === "POST" && feedbackMatch) {
      const run = store.getRun(feedbackMatch[1]); const body = await readBody(req);
      const msg = run?.messages.find((m) => m.id === feedbackMatch[2]);
      if (!msg) return json(res, 404, { error: "Mesaj bulunamadı" });
      msg.feedback = ["up","down"].includes(body.value) ? body.value : null; store.updateRun(run);
      return json(res, 200, { ok: true });
    }
    const branchMatch = p.match(/^\/api\/runs\/([\w-]+)\/branch$/);
    if (req.method === "POST" && branchMatch) {
      const source = store.getRun(branchMatch[1]); const body = await readBody(req);
      if (!source) return json(res, 404, { error: "Sohbet bulunamadı" });
      const at = source.messages.findIndex((m) => m.id === body.messageId);
      const run = store.createRun({ kind:"chat", request:source.request, mode:source.mode, agents:source.agents, projectId:source.projectId, projectDir:source.projectDir, attachments:[], maxDebateRounds:source.maxDebateRounds });
      run.status="idle"; run.phase="idle"; run.title=(source.title || source.request).slice(0,65)+" · dal";
      run.messages = source.messages.slice(0, at >= 0 ? at + 1 : source.messages.length).map((m) => ({...m})); store.updateRun(run);
      return json(res, 200, { runId:run.id });
    }

    // ---- Çoklu ortam yükleme ----
    if (req.method === "POST" && p === "/api/upload") {
      const body = await readBody(req);
      const name = String(body.name || "dosya").replace(/[^\p{L}\p{N}_.\- ]/gu, "_").slice(0, 120);
      const m = String(body.data || "").match(/^data:([^;,]+);base64,(.+)$/s);
      if (!m) return json(res, 400, { error: "Geçerli bir dosya verisi gerekli" });
      const buf = Buffer.from(m[2], "base64");
      if (!buf.length || buf.length > MAX_UPLOAD_BYTES) return json(res, 400, { error: "Dosya boş veya 100 MB sınırını aşıyor" });
      const media = detectMedia(buf, name, m[1]);
      const upDir = path.join(DATA_ROOT, "uploads");
      fs.mkdirSync(upDir, { recursive: true });
      const fname = Date.now().toString(36) + "-" + name;
      const fpath = path.join(upDir, fname);
      fs.writeFileSync(fpath, buf);
      return json(res, 200, { path: fpath, url: "/uploads/" + encodeURIComponent(fname), name, ...media });
    }

    // Google Flow abonelik akışı: üretim Flow arayüzünde kullanıcı tarafından
    // başlatılır; indirilen gerçek video daha sonra bu koşuya bağlanır.
    if (req.method === "POST" && p === "/api/flow-video-runs") {
      const body = await readBody(req);
      const prompt = String(body.prompt || "").trim();
      if (!prompt) return json(res, 400, { error:"Video promptu gerekli" });
      const attachments = sanitizeAttachments(body.attachments);
      const run = store.createRun({ kind:"image_batch", request:prompt, mode:"external", agents:[], projectId:null, projectDir:null, attachments, maxDebateRounds:1 });
      run.title = `${conversationTitle(prompt, 48)} · 1 video`;
      run.phase = "flow_waiting";
      run.status = "running";
      run.imageStudio = { engine:"google-flow-subscription", mediaKind:"video", aspect:String(body.aspect||"16:9"), quality:String(body.quality||"standard"), duration:String(body.duration||"8"), count:1 };
      run.batch = { total:1, completed:0, failed:0, startedAt:new Date().toISOString(), endedAt:null };
      run.tasks = [{ id:"flow-video", title:"Flow videosu", assignee:"google-flow", prompt, status:"waiting", result:null, error:null, attachments:[] }];
      store.addMessage(run, { from:"sistem", kind:"info", content:"Google Flow açıldı. Prompt panoya kopyalandı; Flow'da üretimi başlatın. İndirilen video otomatik olarak bu karta eklenecek." });
      store.updateRun(run);
      return json(res, 202, { runId:run.id, prompt });
    }

    const flowImportMatch = p.match(/^\/api\/flow-video-runs\/([\w-]+)\/import-path$/);
    if (req.method === "POST" && flowImportMatch) {
      if (!uiAuthorized(req)) return json(res,403,{error:"Yetkisiz arayüz isteği"});
      const run = store.getRun(flowImportMatch[1]);
      const body = await readBody(req);
      const source = path.resolve(String(body.path || ""));
      if (!run || run.imageStudio?.engine !== "google-flow-subscription") return json(res,404,{error:"Flow üretimi bulunamadı"});
      if (!source || !fs.existsSync(source) || !fs.statSync(source).isFile()) return json(res,400,{error:"İndirilen video bulunamadı"});
      const stat=fs.statSync(source);
      if (stat.size > 2 * 1024 * 1024 * 1024) return json(res,400,{error:"Video 2 GB sınırını aşıyor"});
      const head=fs.readFileSync(source).subarray(0,8192);
      const media=detectMedia(head,path.basename(source));
      if(media.kind!=="video")return json(res,400,{error:"Seçilen dosya desteklenen bir video değil"});
      const upDir=path.join(DATA_ROOT,"uploads"); fs.mkdirSync(upDir,{recursive:true});
      const safeName=path.basename(source).replace(/[^\p{L}\p{N}_.\- ]/gu,"_").slice(0,120)||"flow-video.mp4";
      const fname=`flow-${Date.now().toString(36)}-${safeName}`; const target=path.join(upDir,fname);
      fs.copyFileSync(source,target);
      const attachment={path:target,url:"/uploads/"+encodeURIComponent(fname),name:safeName,mime:media.mime,kind:"video",size:stat.size,generated:true};
      const task=run.tasks?.[0]; if(task){task.status="done";task.result=target;task.error=null;task.attachments=[attachment];task.endedAt=new Date().toISOString();}
      run.batch.completed=1;run.batch.failed=0;run.batch.endedAt=new Date().toISOString();run.status="done";run.phase="done";
      store.addMessage(run,{from:"sistem",kind:"result",content:"Flow videosu stüdyoya aktarıldı.",attachments:[attachment]});
      store.updateRun(run);
      return json(res,200,{ok:true,attachment});
    }
    const flowFailMatch = p.match(/^\/api\/flow-video-runs\/([\w-]+)\/fail$/);
    if(req.method==="POST"&&flowFailMatch){if(!uiAuthorized(req))return json(res,403,{error:"Yetkisiz arayüz isteği"});const run=store.getRun(flowFailMatch[1]);const body=await readBody(req);if(!run)return json(res,404,{error:"Flow üretimi bulunamadı"});const task=run.tasks?.[0];if(run.status==="done"||task?.result||task?.attachments?.some(a=>a.kind==="video"))return json(res,200,{ok:true,ignored:true});const message=String(body.error||"Flow üretimi başarısız");if(task){task.status="failed";task.error=message;task.endedAt=new Date().toISOString();}run.batch.failed=1;run.batch.endedAt=new Date().toISOString();run.status="failed";run.phase="failed";store.addMessage(run,{from:"sistem",kind:"error",content:message});store.updateRun(run);return json(res,200,{ok:true});}

    // ---- Yüklenen görselleri servis et ----
    if (req.method === "GET" && p.startsWith("/uploads/")) {
      let uploadName = "";
      try { uploadName = decodeURIComponent(p.slice("/uploads/".length)); } catch {}
      const uploadDir = path.join(DATA_ROOT, "uploads");
      const file = path.join(uploadDir, uploadName);
      if (!uploadName || path.basename(uploadName) !== uploadName || !isWithin(uploadDir, file)) {
        res.writeHead(404); return res.end();
      }
      try {
        const data = fs.readFileSync(file);
        const mime = detectMedia(data, file).mime;
        const headers = { "Content-Type": mime, "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(uploadName)}`, "Cache-Control": "max-age=86400", "X-Content-Type-Options":"nosniff" };
        if (mime === "image/svg+xml" || mime === "text/html") headers["Content-Security-Policy"] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:";
        res.writeHead(200, headers);
        return res.end(data);
      } catch {
        res.writeHead(404); return res.end();
      }
    }

    if (req.method === "POST" && p === "/api/media/reveal") {
      const body = await readBody(req);
      const name = path.basename(String(body.url || body.name || ""));
      const file = path.join(DATA_ROOT, "uploads", name);
      if (!isWithin(path.join(DATA_ROOT, "uploads"), file) || !fs.existsSync(file)) return json(res, 404, { error:"Dosya bulunamadı" });
      await execP("open", ["-R", file]);
      return json(res, 200, { ok:true });
    }

    // ---- Klasör gezgini (yalnızca ev dizini altı, yalnızca dizinler) ----
    if (req.method === "GET" && p === "/api/fs") {
      let dir = path.resolve(url.searchParams.get("path") || path.join(HOME, "Desktop"));
      if (!isWithin(HOME, dir)) dir = HOME;
      let dirs = [];
      try {
        dirs = fs.readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
          .map((e) => {
            const full = path.join(dir, e.name);
            return { name: e.name, path: full, git: fs.existsSync(path.join(full, ".git")) };
          })
          .sort((a, b) => a.name.localeCompare(b.name, "tr"));
      } catch (e) {
        return json(res, 400, { error: "Dizin okunamadı: " + String(e.message || e) });
      }
      const parent = dir === HOME ? null : path.dirname(dir);
      return json(res, 200, { path: dir, parent, dirs });
    }

    // ---- Yeni proje oluştur (dizin + git init) ----
    if (req.method === "POST" && p === "/api/projects/create") {
      const body = await readBody(req);
      const name = String(body.name || "").trim().replace(/[/\\:]/g, "-");
      if (!name || name === "." || name === "..") return json(res, 400, { error: "Geçerli bir proje adı gerekli" });
      let parent = path.resolve(String(body.parent || path.join(HOME, "Desktop")));
      if (!isWithin(HOME, parent)) return json(res, 400, { error: "Proje yalnızca ev dizini altında oluşturulabilir" });
      const target = path.resolve(parent, name);
      if (!isWithin(parent, target) || target === parent) return json(res, 400, { error: "Geçersiz proje yolu" });
      if (fs.existsSync(target)) return json(res, 400, { error: "Bu isimde bir klasör zaten var: " + target });
      try {
        fs.mkdirSync(target, { recursive: true });
        await execP("git", ["init"], { cwd: target });
        const proj = config.addProject({ name, path: target });
        store.emit("event", { type: "config" });
        return json(res, 200, proj);
      } catch (e) {
        return json(res, 500, { error: "Proje oluşturulamadı: " + String(e.message || e) });
      }
    }

    // ---- Ayarlar (ajan modeli/rolü, aktif proje) ----
    if (req.method === "POST" && p === "/api/config") {
      const body = await readBody(req);
      config.update(body);
      store.emit("event", { type: "config" });
      return json(res, 200, config.data);
    }

    // ---- Projeler ----
    if (req.method === "POST" && p === "/api/projects") {
      const body = await readBody(req);
      try {
        const proj = config.addProject(body);
        store.emit("event", { type: "config" });
        return json(res, 200, proj);
      } catch (e) {
        return json(res, 400, { error: String(e.message || e) });
      }
    }
    const projectPatch=p.match(/^\/api\/projects\/([\w-]+)\/settings$/);
    if(req.method==="PATCH"&&projectPatch){try{return json(res,200,config.updateProject(projectPatch[1],await readBody(req)));}catch(error){return json(res,404,{error:error.message});}}
    const memoryMatch=p.match(/^\/api\/projects\/([\w-]+)\/memory(?:\/(forget|pin|flag))?$/);
    if(memoryMatch){const project=config.getProject(memoryMatch[1]);if(!project)return json(res,404,{error:"Proje bulunamadı"});const action=memoryMatch[2];if(req.method==="GET"&&!action)return json(res,200,{content:orch.projectContext.readMemory(project.id),pins:workspaceState.data.memoryPins[project.id]||[]});const body=await readBody(req);if(req.method==="PATCH"&&!action){const content=orch.projectContext.writeMemory(project.id,body.content);workspaceState.record("memory.edit",{},project.id);return json(res,200,{content});}if(req.method==="POST"&&action==="forget"){const content=orch.projectContext.forget(project.id,body.query);workspaceState.record("memory.forget",{query:body.query},project.id);return json(res,200,{content});}if(req.method==="POST"&&(action==="pin"||action==="flag")){const pins=workspaceState.data.memoryPins[project.id]||=[],text=String(body.text||"").slice(0,2000),flag=action==="flag"?String(body.flag||"çelişkili"):null;pins.push({id:crypto.randomUUID(),text,flag,createdAt:new Date().toISOString()});workspaceState.save();const current=orch.projectContext.readMemory(project.id)||"# Proje hafızası\n";orch.projectContext.writeMemory(project.id,`${current}\n## ${flag?"İŞARETLİ BİLGİ":"SABİT BİLGİ"}\n- ${text}${flag?`\n- Durum: ${flag}`:""}\n`);return json(res,200,{pins});}}
    const devMatch=p.match(/^\/api\/projects\/([\w-]+)\/dev(?:\/(start|stop))?$/);
    if(devMatch){const project=config.getProject(devMatch[1]);if(!project)return json(res,404,{error:"Proje bulunamadı"});const action=devMatch[2];try{if(req.method==="POST"&&action==="start")return json(res,200,devView(startDevSession(project)));if(req.method==="POST"&&action==="stop"){const s=devSessions.get(project.id);if(s?.alive)s.child.kill("SIGTERM");return json(res,200,{ok:true});}if(req.method==="GET"&&!action)return json(res,200,devView(devSessions.get(project.id)));}catch(error){return json(res,400,{error:error.message});}}
    const artifactsMatch=p.match(/^\/api\/projects\/([\w-]+)\/artifacts$/);
    if(req.method==="GET"&&artifactsMatch){const project=config.getProject(artifactsMatch[1]);if(!project)return json(res,404,{error:"Proje bulunamadı"});const allowed=/\.(html?|svg|md|json|txt|pdf|png|jpe?g|webp|mp4|webm)$/i;const out=[];const walk=(dir,depth=0)=>{if(depth>4||out.length>300)return;for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(e.name.startsWith(".")||["node_modules","dist","build",".next"].includes(e.name))continue;const full=path.join(dir,e.name);if(e.isDirectory())walk(full,depth+1);else if(allowed.test(e.name)){const st=fs.statSync(full);out.push({path:full,name:e.name,relative:path.relative(project.path,full),mtimeMs:st.mtimeMs,size:st.size});}}};walk(project.path);out.sort((a,b)=>b.mtimeMs-a.mtimeMs);return json(res,200,{artifacts:out.slice(0,100)});}
    const checkpointMatch=p.match(/^\/api\/projects\/([\w-]+)\/checkpoints(?:\/([\w-]+)\/restore)?$/);
    if(checkpointMatch){const project=config.getProject(checkpointMatch[1]);if(!project)return json(res,404,{error:"Proje bulunamadı"});const base=path.join(checkpointsDir,project.id);fs.mkdirSync(base,{recursive:true});if(req.method==="GET"&&!checkpointMatch[2]){const items=fs.readdirSync(base).map(id=>{try{return JSON.parse(fs.readFileSync(path.join(base,id,"meta.json"),"utf8"));}catch{return null;}}).filter(Boolean).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));return json(res,200,{checkpoints:items});}if(req.method==="POST"&&!checkpointMatch[2]){const body=await readBody(req),id=Date.now().toString(36),dir=path.join(base,id),snapshot=path.join(dir,"files");fs.mkdirSync(dir,{recursive:true});copyCheckpoint(project.path,snapshot);const meta={id,name:String(body.name||"Kontrol noktası").slice(0,80),createdAt:new Date().toISOString()};fs.writeFileSync(path.join(dir,"meta.json"),JSON.stringify(meta));return json(res,200,meta);}if(req.method==="POST"&&checkpointMatch[2]){const snapshot=path.join(base,checkpointMatch[2],"files");if(!fs.existsSync(snapshot))return json(res,404,{error:"Kontrol noktası bulunamadı"});copyCheckpoint(snapshot,project.path);return json(res,200,{ok:true});}}
    const projDel = p.match(/^\/api\/projects\/([\w-]+)$/);
    if (req.method === "DELETE" && projDel) {
      config.removeProject(projDel[1]);
      store.emit("event", { type: "config" });
      return json(res, 200, { ok: true });
    }

    // Yaratıcı stüdyo prompt güçlendirme: kalıcı sohbet/koşu oluşturmaz.
    if (req.method === "POST" && p === "/api/studio/enhance-prompt") {
      const body=await readBody(req); const text=String(body.text||"").trim();
      if(!text) return json(res,400,{error:"Önce kısa fikrinizi yazın"});
      try { const prompt=await orch.enhanceStudioPrompt({text,mediaKind:body.mediaKind==="video"?"video":"image",engine:String(body.engine||"openai-image"),aspect:String(body.aspect||"1:1"),quality:String(body.quality||"standard"),duration:String(body.duration||"auto"),attachments:sanitizeAttachments(body.attachments)}); return json(res,200,{prompt}); }
      catch(error){ return json(res,500,{error:String(error.message||error)}); }
    }

    // ---- Yeni koşu ----
    if (req.method === "POST" && p === "/api/image-batches") {
      const body = await readBody(req);
      const basePrompt = String(body.prompt || "").trim();
      const mediaKind = body.mediaKind === "video" ? "video" : "image";
      const engine = String(body.engine || (mediaKind === "video" ? "gemini-omni-video" : "openai-image"));
      let prompts = Array.isArray(body.prompts) ? body.prompts.map((v) => String(v || "").trim()).filter(Boolean) : [];
      if (!prompts.length && basePrompt) {
        const count = Math.max(1, Math.min(Number(body.count) || 1, 30));
        prompts = Array.from({ length:count }, (_, i) => count === 1 ? basePrompt : `${basePrompt}\nVaryasyon ${i + 1}/${count}: özgün kompozisyon ve ayrıntılar kullan.`);
      }
      if (!prompts.length) return json(res, 400, { error:"En az bir üretim promptu gerekli" });
      if (prompts.length > 30) return json(res, 400, { error:"Tek seferde en fazla 30 görsel üretilebilir" });
      const enabledMembers = config.data.members.filter((m) => m.enabled && ["claude","codex","antigravity"].includes(m.provider));
      const requestedIds = Array.isArray(body.agents) ? new Set(body.agents.map(String)) : null;
      let members = requestedIds?.size ? enabledMembers.filter((m) => requestedIds.has(m.id)) : enabledMembers;
      const generatorProvider = engine === "openai-image" ? "codex" : "antigravity";
      const generator = enabledMembers.find((m) => m.provider === generatorProvider);
      if (!generator) return json(res, 400, { error:`${generatorProvider === "codex" ? "OpenAI GPT Image" : "Gemini medya"} motoru için etkin ${generatorProvider === "codex" ? "Codex" : "Antigravity"} üyesi gerekli` });
      if (!members.length) return json(res, 400, { error:"En az bir etkin üretim danışmanı seçin" });
      if (!members.some((m) => m.id === generator.id)) members.push(generator);
      const styleLabels = { photorealistic:"Fotogerçekçi", cinematic:"Sinematik", illustration:"İllüstrasyon", "concept-art":"Konsept sanat", product:"Ürün fotoğrafı" };
      if (styleLabels[body.style]) prompts = prompts.map((item) => `${item}\nİstenen görsel stili: ${styleLabels[body.style]}.`);
      const project = body.projectId ? config.getProject(body.projectId) : null;
      const run = store.createRun({ kind:"image_batch", request:basePrompt || prompts.join("\n"), mode:"split", agents:members.map((m) => m.id), projectId:project?.id || null, projectDir:project?.path || null, maxDebateRounds:1, attachments:sanitizeAttachments(body.attachments) });
      run.title = String(body.title || `${conversationTitle(basePrompt || prompts[0], 48)} · ${prompts.length} ${mediaKind === "video" ? "video" : "görsel"}`).slice(0, 80);
      const veoMustUseEight=engine==="veo-3.1" && (sanitizeAttachments(body.attachments).length>0 || ["high","4k"].includes(String(body.quality)));
      const duration=mediaKind==="video" && engine==="veo-3.1" && ["4","6","8"].includes(String(body.duration)) ? (veoMustUseEight?"8":String(body.duration)) : "auto";
      run.imageStudio = { adviserIds:[], engine, mediaKind, aspect:String(body.aspect||"1:1"), quality:String(body.quality||"standard"), duration, generatorId:generator.id, count:prompts.length };
      orch.startImageBatch(run, { prompts, concurrency:body.concurrency });
      return json(res, 202, { runId:run.id, total:prompts.length });
    }

    if (req.method === "POST" && p === "/api/runs") {
      const body = await readBody(req);
      if (!body.request?.trim()) return json(res, 400, { error: "Görev metni boş olamaz" });
      // Etkin ajanlar ayarlardan gelir; istek gövdesi isterse daraltabilir
      const enabled = config.data.members.filter((m) => m.enabled).map((m) => m.id);
      const agents = enabled;
      if (!agents.length) return json(res, 400, { error: "Etkin üye yok — kenar çubuğundan üye ekleyin" });
      const project = body.projectId ? config.getProject(body.projectId) : null;
      const requestedMode = ["auto", "discussion", "split", "code"].includes(body.mode) ? body.mode : "auto";
      const run = store.createRun({
        request: body.request.trim(),
        mode: requestedMode,
        agents,
        projectId: project?.id || null,
        projectDir: project?.path || null,
        testCommand: body.testCommand?.trim() || null,
        maxDebateRounds: Math.max(1, Math.min(Number(body.maxDebateRounds) || 2, 4)),
        attachments: sanitizeAttachments(body.attachments),
      });
      run.testFirst = !!body.testFirst;
      orch.startRun(run);
      return json(res, 200, { runId: run.id });
    }

    // ---- Sohbet: yeni sohbet veya mevcut sohbete mesaj ----
    if (req.method === "POST" && p === "/api/chat") {
      const body = await readBody(req);
      const text = String(body.text || "").trim();
      if (!text) return json(res, 400, { error: "Mesaj boş olamaz" });
      const enabled = config.data.members.filter((m) => m.enabled).map((m) => m.id);
      if (!enabled.length) return json(res, 400, { error: "Etkin üye yok — kenar çubuğundan üye ekleyin" });

      let run = body.conversationId ? store.getRun(body.conversationId) : null;
      if (run && run.kind !== "chat") run = null;
      if (run?.turnActive || run?.directActive) {
        const chatMode = ["auto", "discussion", "split", "code"].includes(body.mode) ? body.mode : "auto";
        const queued = orch.enqueueMessage(run, {
          target: "konsey", text, mode: chatMode,
          attachments: sanitizeAttachments(body.attachments),
        });
        return json(res, 202, { runId: run.id, queued: true, queueId: queued.id });
      }

      if (!run) {
        const project = body.projectId ? config.getProject(body.projectId) : null;
        run = store.createRun({
          kind: "chat",
          request: text,
          mode: "auto",
          agents: enabled,
          projectId: project?.id || null,
          projectDir: project?.path || null,
          testCommand: body.testCommand?.trim() || null,
          maxDebateRounds: Math.max(1, Math.min(Number(body.maxDebateRounds) || 2, 4)),
          attachments: [],
        });
        run.status = "idle";
        run.title = conversationTitle(text);
      }
      if (body.testCommand?.trim()) run.testCommand = body.testCommand.trim();
      run.testFirst = !!body.testFirst;
      const chatMode = ["auto", "discussion", "split", "code"].includes(body.mode) ? body.mode : "auto";
      orch.continueChat(run, text, sanitizeAttachments(body.attachments), chatMode)
        .catch(() => {});
      return json(res, 200, { runId: run.id });
    }

    // ---- Boş ekrandan tek üyeyle doğrudan sohbet başlatma ----
    if (req.method === "POST" && p === "/api/direct-chat") {
      const body = await readBody(req);
      const text = String(body.text || "").trim();
      if (!text) return json(res, 400, { error: "Mesaj boş olamaz" });
      const member = config.data.members.find((m) => m.id === body.to && m.enabled);
      if (!member) return json(res, 400, { error: "Etkin hedef üye bulunamadı" });
      const project = body.projectId ? config.getProject(body.projectId) : null;
      const run = store.createRun({
        kind: "chat",
        request: text,
        mode: "auto",
        agents: [member.id],
        projectId: project?.id || null,
        projectDir: project?.path || null,
        testCommand: null,
        maxDebateRounds: 1,
        attachments: [],
      });
      run.status = "idle";
      run.phase = "idle";
      run.title = conversationTitle(text);
      store.updateRun(run);
      orch.directMessage(run, member.id, text, sanitizeAttachments(body.attachments)).catch((err) => {
        store.addMessage(run, { from: "sistem", kind: "error", content: "Doğrudan sohbet hatası: " + String(err.message || err) });
      });
      return json(res, 200, { runId: run.id });
    }

    // ---- Koşu/tur durdurma ----
    const stopMatch = p.match(/^\/api\/runs\/([\w-]+)\/stop$/);
    if (req.method === "POST" && stopMatch) {
      const run = store.getRun(stopMatch[1]);
      if (!run) return json(res, 404, { error: "Koşu bulunamadı" });
      if (run.kind === "chat") orch.stopTurn(run);
      else orch.stopRun(run);
      return json(res, 200, { ok: true });
    }

    // ---- Kesinti sonrası devam ----
    const resumeMatch = p.match(/^\/api\/runs\/([\w-]+)\/resume$/);
    if (req.method === "POST" && resumeMatch) {
      const run = store.getRun(resumeMatch[1]);
      if (!run) return json(res, 404, { error: "Koşu bulunamadı" });
      try {
        orch.resumeRun(run);
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 400, { error: String(e.message || e) });
      }
    }

    // ---- Geri alma: koşunun dallarını ve worktree'lerini sil ----
    const rbMatch = p.match(/^\/api\/runs\/([\w-]+)\/rollback$/);
    if (req.method === "POST" && rbMatch) {
      const run = store.getRun(rbMatch[1]);
      if (!run) return json(res, 404, { error: "Koşu bulunamadı" });
      try {
        const deleted = await orch.rollback(run);
        return json(res, 200, { ok: true, deleted });
      } catch (e) {
        return json(res, 400, { error: String(e.message || e) });
      }
    }

    // ---- Sağlık kontrolü (yeniden tetikleme) ----
    if (req.method === "POST" && p === "/api/health") {
      const health = await orch.checkHealth();
      return json(res, 200, health);
    }

    // ---- Doğrudan ajan mesajı ----
    const msgMatch = p.match(/^\/api\/runs\/([\w-]+)\/message$/);
    if (req.method === "POST" && msgMatch) {
      const run = store.getRun(msgMatch[1]);
      if (!run) return json(res, 404, { error: "Koşu bulunamadı" });
      const body = await readBody(req);
      if (!body.to || !body.content?.trim()) return json(res, 400, { error: "to ve content gerekli" });
      const attachments = sanitizeAttachments(body.attachments);
      if (run.turnActive || run.directActive) {
        const queued = orch.enqueueMessage(run, { target: body.to, text: body.content.trim(), attachments });
        return json(res, 202, { ok: true, queued: true, queueId: queued.id });
      }
      orch.directMessage(run, body.to, body.content.trim(), attachments).catch(() => {});
      return json(res, 200, { ok: true, queued: false });
    }

    // ---- Görev yeniden atama (görev henüz başlamadıysa) ----
    const reMatch = p.match(/^\/api\/runs\/([\w-]+)\/tasks\/([\w-]+)\/reassign$/);
    if (req.method === "POST" && reMatch) {
      const run = store.getRun(reMatch[1]);
      if (!run) return json(res, 404, { error: "Koşu bulunamadı" });
      const task = run.tasks.find((t) => t.id === reMatch[2]);
      if (!task) return json(res, 404, { error: "Görev bulunamadı" });
      if (task.status !== "pending") return json(res, 409, { error: "Görev zaten başladı; yeniden atanamaz" });
      const body = await readBody(req);
      if (!config.data.members.some((m) => m.id === body.assignee)) return json(res, 400, { error: "Geçersiz üye" });
      task.assignee = body.assignee;
      store.updateRun(run);
      store.addMessage(run, { from: "kullanici", kind: "info", taskId: task.id, content: `Görev kullanıcı tarafından ${body.assignee} üyesine atandı.` });
      return json(res, 200, { ok: true });
    }

    // ---- Onay kararı ----
    const apMatch = p.match(/^\/api\/approvals\/([\w-]+)$/);
    if (req.method === "POST" && apMatch) {
      const body = await readBody(req);
      const decision = body.decision === "approve" ? "approved" : "rejected";
      const ap = store.resolveApproval(apMatch[1], decision);
      if (!ap) return json(res, 404, { error: "Onay bulunamadı veya zaten sonuçlandı" });
      return json(res, 200, { ok: true });
    }

    // ---- Rapor ----
    const repMatch = p.match(/^\/api\/runs\/([\w-]+)\/report$/);
    if (req.method === "GET" && repMatch) {
      const run = store.getRun(repMatch[1]);
      if (!run?.report) return json(res, 404, { error: "Rapor henüz yok" });
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
      return res.end(run.report);
    }

    // ---- Antigravity köprü talimatı ----
    if (req.method === "GET" && p === "/api/bridge/instructions") {
      return serveFile(res, path.join(ROOT, "bridge", "antigravity", "INSTRUCTIONS.md"));
    }

    if (req.method === "POST" && p === "/api/bridge/open") {
      const bridgeDir = path.join(ROOT, "bridge", "antigravity");
      await execP("open", ["-a", "Antigravity", bridgeDir]);
      await execP("open", ["-a", "Antigravity", path.join(bridgeDir, "INSTRUCTIONS.md")]);
      return json(res, 200, { ok: true, path: bridgeDir });
    }

    if (req.method === "POST" && p === "/api/bridge/test") {
      try {
        return json(res, 200, await orch.testAntigravityBridge());
      } catch (e) {
        return json(res, 504, { error: String(e.message || e) });
      }
    }

    json(res, 404, { error: "Bulunamadı" });
  } catch (err) {
    json(res, 500, { error: String(err.message || err) });
  }
});

// Yalnızca bizim uploads/ klasörümüzdeki dosyalar ek olarak kabul edilir
function sanitizeAttachments(list) {
  if (!Array.isArray(list)) return [];
  const upDir = path.join(DATA_ROOT, "uploads") + path.sep;
  return list
    .filter((a) => a && typeof a.path === "string" && isWithin(upDir, path.resolve(a.path)) && fs.existsSync(a.path))
    .map((a) => ({ path: path.resolve(a.path), url: String(a.url || ""), name: String(a.name || ""), mime: String(a.mime || "application/octet-stream"), kind: String(a.kind || "file"), size: Number(a.size || 0), sha256: String(a.sha256 || "") }))
    .slice(0, 16);
}

function serveFile(res, file) {
  try {
    const data = fs.readFileSync(file);
    res.writeHead(200, { "Content-Type": (MIME[path.extname(file)] || "text/plain") + "; charset=utf-8" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("bulunamadı");
  }
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Ajan Konseyi hazır → http://localhost:${PORT}`);
  console.log(`Antigravity köprü talimatı: bridge/antigravity/INSTRUCTIONS.md`);
  // Açılışta ve her 10 dakikada bir CLI sağlık kontrolü
  orch.checkHealth().catch(() => {});
  setTimeout(()=>{for(const run of Object.values(store.runs)){if(run.status==="interrupted"&&run.autoResume&&run.kind!=="chat")orch.resumeRun(run);}},3500);
  setInterval(() => orch.checkHealth().catch(() => {}), 10 * 60 * 1000);
});
