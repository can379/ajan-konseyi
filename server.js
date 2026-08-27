import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./src/store.js";
import { SpeechToText } from "./src/speech.js";
import { CanSellerAI, temizleKayit } from "./src/cansellerai.js";
import { RdpController } from "./src/rdpController.js";
import { OpsRun, jsonAyikla } from "./src/opsRun.js";
import { OpsJobs } from "./src/opsJobs.js";
import { OpsWorker, FazAyari } from "./src/opsWorker.js";
import { KillSwitch, DevreKesici, PolitikaKaydi } from "./src/opsGuvenlik.js";
import { opsMetrikleri } from "./src/opsMetrik.js";
import { OpsWatcher } from "./src/opsWatcher.js";
import { komutCoz, yorumIstemi, yorumDogrula } from "./src/opsKomut.js";
import { OYUN_KITABI } from "./src/opsPlaybook.js";
import { Orchestrator } from "./src/orchestrator.js";
import { Config, ROLES } from "./src/config.js";
import { copyCheckpoint } from "./src/checkpoints.js";
import { MODEL_CATALOG, EFFORT_LEVELS } from "./src/models.js";
import { detectMedia, MAX_UPLOAD_BYTES, PROVIDER_CAPABILITIES } from "./src/media.js";
import { discoverCapabilities } from "./src/capabilityDiscovery.js";
import { conversationTitle, distributeRunUsage, summarizeCalendarMonth } from "./src/util.js";
import { BrowserBridge } from "./src/browserBridge.js";
import { WorkspaceState } from "./src/workspaceState.js";
import { saveOpenRouterKey, deleteOpenRouterKey, openRouterStatus } from "./src/credentialStore.js";
import { exportRunArtifacts } from "./src/artifactExport.js";
import { excludedProvidersFromText, normalizeExcludedProviders } from "./src/providerPolicy.js";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import readline from "node:readline";
const execP = promisify(execFile);
const HOME = os.homedir();

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Kaynaklar uygulama paketinde salt okunur olabilir. Kullanıcıya ait sohbet,
// ayar, yükleme ve günlükler ayrı bir yazılabilir veri dizininde tutulur.
// Geliştirici modunda env verilmezse mevcut davranış korunur.
const DATA_ROOT = path.resolve(process.env.AJAN_KONSEYI_DATA_DIR || ROOT);
const PORT = process.env.PORT || 4780;
const UI_TOKEN = process.env.AJAN_UI_TOKEN || "";
const { runBackup, detectGoogleDrive } = await import("./src/backup.js");
const BRIDGE_TOKEN = process.env.AJAN_BROWSER_BRIDGE_TOKEN || "";

fs.mkdirSync(DATA_ROOT, { recursive: true });
const store = new Store(DATA_ROOT);
const speech = new SpeechToText(DATA_ROOT);
const canseller = new CanSellerAI({ dataRoot: DATA_ROOT });
canseller.oturumuYukle();   // "cansellerai sitesinde surekli var olsun" — oturum yeniden baslatmada kaybolmaz
const config = new Config(DATA_ROOT);
const orch = new Orchestrator(store, DATA_ROOT, config);
const rdp = new RdpController(DATA_ROOT, { computerBridge: orch.computerBridge });
const opsJobs = new OpsJobs();
// Faz kapisi: varsayilan Faz 1. Kullanici tek tek is turu acabilir; genel
// siniri yukseltmek hepsini birden acardi, bu yuzden tur bazli kapi var.
const opsKill = new KillSwitch(DATA_ROOT);
const opsKesici = new DevreKesici();
const opsPolitika = new PolitikaKaydi(DATA_ROOT);
const opsFaz = new FazAyari(undefined, { politika: opsPolitika });
const opsRun = new OpsRun({ controller: rdp, orchestrator: orch, store, config, jobs: opsJobs, faz: opsFaz });
const opsWorker = new OpsWorker({ jobs: opsJobs, controller: rdp, orchestrator: orch, store, config, faz: opsFaz,
  killSwitch: opsKill, kesici: opsKesici });
const opsWatcher = new OpsWatcher({ canseller, jobs: opsJobs, store, faz: opsFaz });
openRouterStatus().then((status)=>{
  let members=config.data.members.filter(member=>member.provider!=="openrouter");
  if(status.configured)members.push({id:"m-ox-alpha",name:"Ox Alpha",provider:"openrouter",role:"arastirmaci",model:"stealth/ox-alpha",effort:"",enabled:true});
  const coordinator=!status.configured&&config.data.coordinator?.provider==="openrouter"?{provider:"claude",model:"",effort:""}:config.data.coordinator;
  config.update({members,coordinator,apiProviders:{openrouter:status}});
}).catch(()=>{});
const browserBridge = new BrowserBridge({ bridgeToken:BRIDGE_TOKEN });
const workspaceState=new WorkspaceState(DATA_ROOT);
store.on("event",event=>{if(event.runId){const run=store.getRun(event.runId);if(run)workspaceState.syncRun(run);}});
orch.browserBridge = browserBridge;
orch.resourceLeases = workspaceState;
orch.artifactExporter=(run,stage="snapshot")=>{const project=config.getProject(run.projectId);if(!project?.artifactExport)return null;const result=exportRunArtifacts(project.path,run,{stage});workspaceState.record("artifact.export",{runId:run.id,stage,relative:result.relative,files:result.files},project.id);return result;};
setInterval(()=>{for(const schedule of workspaceState.data.schedules||[]){if(schedule.status!=="scheduled"||Date.now()<+new Date(schedule.at))continue;const project=config.getProject(schedule.projectId),agents=config.data.members.filter(member=>member.enabled).map(member=>member.id);if(!agents.length){schedule.status="blocked";schedule.error="Etkin ajan yok";workspaceState.save();continue;}const run=store.createRun({request:schedule.request,mode:"auto",agents,projectId:project?.id||null,projectDir:project?.path||null,attachments:[],maxDebateRounds:2});run.budget={enabled:false,maxCalls:24,maxTokens:250000,stopped:false};schedule.status="started";schedule.runId=run.id;schedule.startedAt=new Date().toISOString();workspaceState.save();orch.startRun(run);}},15000).unref();

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

let providerQuotaCache={at:0,value:{}};
let providerAccountUsageCache={at:0,value:{},refreshing:false};
let antigravityQuotaCache={at:0,refreshing:false,value:null};
function estimateRollingReset(samples,key,windowMs){
  if(!samples.length)return null;
  const latest=samples.at(-1),latestValue=Number(latest?.u?.[key]);
  let segmentStart=latest.t;
  for(let index=samples.length-2;index>=0;index--){const current=Number(samples[index]?.u?.[key]),next=Number(samples[index+1]?.u?.[key]);if(!Number.isFinite(current)||!Number.isFinite(next))continue;if(next+1<current){segmentStart=samples[index+1].t;break;}segmentStart=samples[index].t;}
  // Claude pencereleri kayan pencerelerdir. Kesin reset zamanı dosyada yer
  // almadığı için yalnız pencerenin başlangıcı bulunabildiğinde gösterilir.
  return Number.isFinite(latestValue)&&segmentStart?new Date(segmentStart+windowMs).toISOString():null;
}
function readClaudePlanQuota(){
  const file=path.join(HOME,"Library","Application Support","Claude","plan-usage-history.json");
  try{
    const parsed=JSON.parse(fs.readFileSync(file,"utf8")),samples=(Array.isArray(parsed.samples)?parsed.samples:[]).filter(item=>Number.isFinite(item?.t)&&item?.u).sort((a,b)=>a.t-b.t),latest=samples.at(-1);
    if(!latest)return null;
    const fiveUsed=Number(latest.u.fh),weekUsed=Number(latest.u.sd),windows=[];
    if(Number.isFinite(fiveUsed))windows.push({name:"five_hour",label:"5 saatlik kota",usedPercent:fiveUsed,remainingPercent:Math.max(0,100-fiveUsed),windowMinutes:300,resetsAt:estimateRollingReset(samples,"fh",5*60*60_000),updatedAt:new Date(latest.t).toISOString(),stale:Date.now()-latest.t>60*60_000});
    if(Number.isFinite(weekUsed))windows.push({name:"weekly",label:"Haftalık kota",usedPercent:weekUsed,remainingPercent:Math.max(0,100-weekUsed),windowMinutes:7*24*60,resetsAt:estimateRollingReset(samples,"sd",7*24*60*60_000),updatedAt:new Date(latest.t).toISOString(),stale:Date.now()-latest.t>60*60_000});
    return windows.length?{available:true,source:"Claude masaüstü plan kullanım kaydı",updatedAt:new Date(latest.t).toISOString(),windows,remainingPercent:Math.min(...windows.map(item=>item.remainingPercent)),usedPercent:Math.max(...windows.map(item=>item.usedPercent)),name:"subscription"}:null;
  }catch{return null;}
}
function antigravityIdentity(){
  const roots=[path.join(HOME,"Library","Application Support","Antigravity","logs"),path.join(HOME,".gemini","antigravity-cli")];
  for(const item of roots.flatMap(root=>newestFiles(root,".log",80))){
    try{const tail=readFileSlice(item.path,Math.max(0,item.size-512*1024),Math.min(item.size,512*1024)),email=[...tail.matchAll(/applyAuthResult:\s*email=([^\s,]+)/g)].at(-1)?.[1];if(email)return{accountEmail:email,accountPlan:"Google AI Pro"};}catch{}
  }
  return{accountPlan:"Google AI Pro"};
}
function parseAntigravityQuotaText(text){
  const source=String(text||""),section=(start,end)=>source.slice(source.indexOf(start),end&&source.indexOf(end)>-1?source.indexOf(end):undefined),localizeDuration=value=>String(value||"").replace(/\bdays?\b/gi,"gün").replace(/\bhours?\b/gi,"saat").replace(/\bminutes?\b/gi,"dakika"),parse=(block,label)=>{const after=block.slice(block.indexOf(label)+label.length),percent=after.match(/\b(100|\d{1,2})%/),refresh=after.match(/fully refresh in\s+([^\n.]+(?:minutes?|hours?|days?)[^\n.]*)/i);return percent?{remainingPercent:Number(percent[1]),usedPercent:100-Number(percent[1]),refreshText:refresh?.[1]?localizeDuration(refresh[1].trim()):null}:null;},gemini=section("Gemini Models","Claude and GPT models"),windows=[];
  const weekly=parse(gemini,"Weekly Limit Remaining"),five=parse(gemini,"Five Hour Limit Remaining");
  if(five)windows.push({name:"five_hour",label:"5 saatlik kota",windowMinutes:300,...five,resetsAt:null,updatedAt:new Date().toISOString(),stale:false});
  if(weekly)windows.push({name:"weekly",label:"Haftalık kota",windowMinutes:10080,...weekly,resetsAt:null,updatedAt:new Date().toISOString(),stale:false});
  return windows.length?{available:true,source:"Antigravity Models & Usage yerel sağlayıcı ekranı",updatedAt:new Date().toISOString(),windows,remainingPercent:Math.min(...windows.map(item=>item.remainingPercent)),usedPercent:Math.max(...windows.map(item=>item.usedPercent)),...antigravityIdentity()}:null;
}
function antigravityDevtoolsEvaluate(webSocketDebuggerUrl,expression){return new Promise((resolve,reject)=>{let settled=false;const socket=new WebSocket(webSocketDebuggerUrl),timer=setTimeout(()=>{try{socket.close();}catch{}reject(new Error("Antigravity yerel arayüzü zaman aşımına uğradı"));},8000);socket.addEventListener("open",()=>socket.send(JSON.stringify({id:1,method:"Runtime.evaluate",params:{expression,returnByValue:true,awaitPromise:true}})));socket.addEventListener("message",event=>{const message=JSON.parse(event.data);if(message.id!==1)return;settled=true;clearTimeout(timer);socket.close();resolve(message.result?.result?.value||"");});socket.addEventListener("error",()=>{if(settled)return;clearTimeout(timer);reject(new Error("Antigravity yerel arayüzüne bağlanılamadı"));});});}
async function refreshAntigravityQuota(){
  if(antigravityQuotaCache.refreshing||Date.now()-antigravityQuotaCache.at<5*60_000)return;
  antigravityQuotaCache.refreshing=true;
  try{
    let portFile=path.join(HOME,"Library","Application Support","Antigravity","DevToolsActivePort");
    const findTarget=async()=>{const port=Number(String(fs.readFileSync(portFile,"utf8")).split("\n")[0]),targets=await fetch(`http://127.0.0.1:${port}/json/list`).then(response=>response.json());return targets.find(item=>item.type==="page"&&item.webSocketDebuggerUrl);};
    let target;try{target=await findTarget();}catch{await execP("open",["-gj","-a","Antigravity"]);await new Promise(resolve=>setTimeout(resolve,1800));target=await findTarget();}
    if(!target)throw new Error("Antigravity sayfası bulunamadı");
    const expression=`(async()=>{const text=()=>document.body?.innerText||"";if(!text().includes("Models & Usage")){const settings=[...document.querySelectorAll("button,[role=button],a")].find(element=>element.innerText?.trim()==="Settings");settings?.click();await new Promise(resolve=>setTimeout(resolve,250));const models=[...document.querySelectorAll("button,[role=button],a")].find(element=>element.innerText?.trim()==="Models");models?.click();await new Promise(resolve=>setTimeout(resolve,900));}return text();})()`;
    const text=await antigravityDevtoolsEvaluate(target.webSocketDebuggerUrl,expression),value=parseAntigravityQuotaText(text);
    if(value)antigravityQuotaCache.value=value;
  }catch{}finally{antigravityQuotaCache.at=Date.now();antigravityQuotaCache.refreshing=false;providerQuotaCache.at=0;}
}
function emptyUsageDays(){const days=[];for(let offset=29;offset>=0;offset--){const date=new Date();date.setHours(12,0,0,0);date.setDate(date.getDate()-offset);days.push({day:date.toISOString().slice(0,10),cost:0,tokens:0,calls:0});}return days;}
function usageDay(stamp){return new Date(stamp).toLocaleDateString("en-CA",{timeZone:process.env.TZ||"Europe/Istanbul"});}
function finalizeAccountUsage(provider,records,modelTotals={},source="Yerel sağlayıcı günlükleri"){
  const byDay=new Map(records.map(item=>[item.day,item])),days=emptyUsageDays().map(day=>({...day,...(byDay.get(day.day)||{})}));
  const today=days.at(-1)||{cost:0,tokens:0,calls:0},totals=days.reduce((sum,item)=>({cost:sum.cost+Number(item.cost||0),tokens:sum.tokens+Number(item.tokens||0),calls:sum.calls+Number(item.calls||0)}),{cost:0,tokens:0,calls:0});
  const calendarMonth=summarizeCalendarMonth(records);
  const mostUsedModel=Object.entries(modelTotals).sort((a,b)=>b[1]-a[1])[0]?.[0]||null;
  return {provider,source,updatedAt:new Date().toISOString(),todayCost:today.cost,month:calendarMonth.month,monthCost:calendarMonth.cost,monthTokens:calendarMonth.tokens,monthCalls:calendarMonth.calls,thirtyDayCost:totals.cost,recentTokens:today.tokens,thirtyDayTokens:totals.tokens,calls:totals.calls,mostUsedModel,days};
}
function claudeRate(model){const name=String(model||"").toLowerCase();if(name.includes("opus-5"))return{input:5,cacheRead:.5,cacheWrite5m:6.25,cacheWrite1h:10,output:25};if(name.includes("opus"))return{input:15,cacheRead:1.5,cacheWrite5m:18.75,cacheWrite1h:30,output:75};if(name.includes("haiku"))return{input:1,cacheRead:.1,cacheWrite5m:1.25,cacheWrite1h:2,output:5};return{input:3,cacheRead:.3,cacheWrite5m:3.75,cacheWrite1h:6,output:15};}
function claudeUsageAmount(usage,model){
  const rate=claudeRate(model),input=Number(usage?.input_tokens||0),cacheRead=Number(usage?.cache_read_input_tokens||0),cacheWrite=Number(usage?.cache_creation_input_tokens||0),cache5m=Number(usage?.cache_creation?.ephemeral_5m_input_tokens||0),cache1h=Number(usage?.cache_creation?.ephemeral_1h_input_tokens||0),unclassifiedCache=Math.max(0,cacheWrite-cache5m-cache1h),output=Number(usage?.output_tokens||0),tokens=input+cacheRead+cacheWrite+output,cost=(input*rate.input+cacheRead*rate.cacheRead+(cache5m+unclassifiedCache)*rate.cacheWrite5m+cache1h*rate.cacheWrite1h+output*rate.output)/1e6;
  return {tokens,cost};
}
async function scanClaudeAccountUsage(){
  const configured=String(process.env.CLAUDE_CONFIG_DIR||"").split(path.delimiter).filter(Boolean).map(root=>path.join(root,"projects")),roots=[...new Set([...configured,path.join(HOME,".claude","projects"),path.join(HOME,".config","claude","projects")])],cutoff=Date.now()-31*86400_000,files=roots.flatMap(root=>newestFiles(root,".jsonl",10000)).filter(item=>item.mtimeMs>=cutoff),daily=new Map(),models={},seen=new Set();
  for(const item of files){const lines=readline.createInterface({input:fs.createReadStream(item.path),crlfDelay:Infinity});for await(const line of lines){let event;try{event=JSON.parse(line);}catch{continue;}const usage=event?.message?.usage,model=event?.message?.model,messageId=event?.message?.id||event.uuid,dedupeKey=[event.sessionId||item.path,messageId,event.requestId||""].join(":");if(event.type!=="assistant"||!usage||!model||model==="<synthetic>"||seen.has(dedupeKey))continue;seen.add(dedupeKey);const stamp=Date.parse(event.timestamp||0);if(!stamp||stamp<cutoff)continue;const parts=Array.isArray(usage.iterations)&&usage.iterations.length?usage.iterations:[usage],day=usageDay(stamp),row=daily.get(day)||{day,cost:0,tokens:0,calls:0};for(const part of parts){const partModel=part.model||model,amount=claudeUsageAmount(part,partModel);row.cost+=amount.cost;row.tokens+=amount.tokens;models[partModel]=(models[partModel]||0)+amount.tokens;}row.calls++;daily.set(day,row);}}
  return finalizeAccountUsage("claude",[...daily.values()],models,"Claude yerel oturum günlükleri · API fiyat eşdeğeri");
}
function codexRate(model){const name=String(model||"").toLowerCase();if(name.includes("spark"))return{input:.5,cached:.05,output:4};if(name.includes("gpt-5.6"))return{input:2.5,cached:.25,output:15};if(name.includes("gpt-5.5"))return{input:2,cached:.2,output:14};return{input:2.5,cached:.25,output:15};}
function readFileSlice(file,start,length){const fd=fs.openSync(file,"r");try{const buffer=Buffer.alloc(length),read=fs.readSync(fd,buffer,0,length,start);return buffer.subarray(0,read).toString("utf8");}finally{fs.closeSync(fd);}}
async function scanCodexAccountUsage(){
  const roots=[path.join(HOME,".codex","sessions"),path.join(HOME,".codex","archived_sessions")],cutoff=Date.now()-31*86400_000,files=roots.flatMap(root=>newestFiles(root,".jsonl",20000)).filter(item=>item.mtimeMs>=cutoff),daily=new Map(),models={};
  // Her oturumdaki son `total_token_usage`, o oturumun kümülatif ve tekil toplamıdır.
  // Dosyanın tamamını yeniden okumak yerine kuyruğu okumak hem aynı çağrıları tekrar
  // saymayı önler hem de çok büyük/uzun oturumlarda uygulamanın açılışını kilitlemez.
  for(const item of files){let model="gpt-5.6-sol",usage=null,stamp=0;try{const head=readFileSlice(item.path,0,Math.min(item.size,256*1024));for(const line of head.split("\n")){try{const event=JSON.parse(line);if(event.type==="turn_context"&&event.payload?.model)model=event.payload.model;else if(event.type==="session_meta"&&event.payload?.model)model=event.payload.model;}catch{}}const tailSize=Math.min(item.size,32*1024*1024),tail=readFileSlice(item.path,item.size-tailSize,tailSize);for(const line of tail.split("\n").reverse()){try{const event=JSON.parse(line);if(event.type==="turn_context"&&event.payload?.model&&!usage)model=event.payload.model;const candidate=event.type==="event_msg"&&event.payload?.type==="token_count"?event.payload?.info?.total_token_usage:null;if(!candidate)continue;usage=candidate;stamp=Date.parse(event.timestamp||0)||item.mtimeMs;break;}catch{}}}catch{continue;}if(!usage||stamp<cutoff)continue;const input=Number(usage.input_tokens||0),cached=Number(usage.cached_input_tokens||0),output=Number(usage.output_tokens||0),tokens=input+output,rate=codexRate(model),cost=(Math.max(0,input-cached)*rate.input+cached*rate.cached+output*rate.output)/1e6,day=usageDay(stamp),row=daily.get(day)||{day,cost:0,tokens:0,calls:0};row.cost+=cost;row.tokens+=tokens;row.calls++;daily.set(day,row);models[model]=(models[model]||0)+tokens;}
  return finalizeAccountUsage("codex",[...daily.values()],models,"Codex yerel oturum ve arşiv günlükleri · API fiyat eşdeğeri");
}
function localAntigravityUsage(){
  const daily=new Map(),models={},cutoff=Date.now()-31*86400_000;for(const run of Object.values(store.runs||{})){for(const [member,total] of Object.entries(run.usage||{})){const configured=config.data.members.find(item=>item.id===member);if(configured?.provider!=="antigravity")continue;const exact=Object.entries(run.usageDaily||{}).map(([day,agents])=>({day,usage:agents?.[member]})).filter(item=>item.usage&&Date.parse(`${item.day}T12:00:00`)>=cutoff),messageDays=[...new Set((run.messages||[]).filter(message=>message.from===member||message.provider==="antigravity").map(message=>usageDay(message.ts)).filter(Boolean))],fallbackDays=messageDays.length?messageDays:[usageDay(run.createdAt||run.updatedAt)].filter(Boolean),records=distributeRunUsage(total,exact,fallbackDays);for(const {day,usage} of records){if(Date.parse(`${day}T12:00:00`)<cutoff)continue;const input=Number(usage.input||0),cached=Number(usage.cachedInput||0),output=Number(usage.output||0),tokens=input+output,cost=((Math.max(0,input-cached)*.5)+(cached*.05)+(output*3))/1e6,row=daily.get(day)||{day,cost:0,tokens:0,calls:0};row.cost+=cost;row.tokens+=tokens;row.calls+=Number(usage.calls||0);daily.set(day,row);}const model=configured.model||"Gemini",tokens=Number(total.input||0)+Number(total.output||0);models[model]=(models[model]||0)+tokens;}}
  return finalizeAccountUsage("antigravity",[...daily.values()],models,"Ajan Konseyi Antigravity kayıtları · API fiyat eşdeğeri");
}
async function scanAntigravityAccountUsage(){
  const exact=localAntigravityUsage(),byDay=new Map((exact.days||[]).filter(item=>item.tokens||item.calls||item.cost).map(item=>[item.day,{...item}]));
  const root=path.join(HOME,".gemini","antigravity-cli","conversations"),cutoff=Date.now()-31*86400_000,files=newestFiles(root,".db",10000).filter(item=>item.mtimeMs>=cutoff);
  const estimatedByDay=new Map();let estimated=false;
  for(const item of files){
    try{
      // Antigravity konuşma DB'leri sağlayıcının kesin token sayacını tutmuyor.
      // Eski hesap geçmişini tamamen yok saymak yerine model isteklerinin metin
      // yükünden muhafazakâr bir yerel tahmin çıkarıyoruz. Ajan Konseyi'nin aynı
      // gün için kesin kaydı varsa `max` sayesinde iki kez sayılmıyor.
      const {stdout}=await execP("/usr/bin/sqlite3",[item.path,"select coalesce(sum(length(step_payload)),0),count(*) from steps where length(step_payload)>0;"],{maxBuffer:1024*1024});
      const [payloadBytes,calls]=String(stdout||"").trim().split("|").map(Number);if(!payloadBytes&&!calls)continue;
      const day=usageDay(item.mtimeMs),tokens=Math.max(0,Math.round(payloadBytes/4)),row=estimatedByDay.get(day)||{day,cost:0,tokens:0,calls:0};
      row.tokens+=tokens;row.cost+=tokens/1e6;row.calls+=Math.max(1,calls||0);estimatedByDay.set(day,row);
    }catch{}
  }
  for(const [day,row] of estimatedByDay){const known=byDay.get(day);if(!known||row.tokens>Number(known.tokens||0)){byDay.set(day,row);estimated=true;}}
  const result=finalizeAccountUsage("antigravity",[...byDay.values()],{"gemini-3.7-flash-medium":[...byDay.values()].reduce((sum,item)=>sum+Number(item.tokens||0),0)},estimated?"Antigravity yerel konuşma geçmişi + Ajan Konseyi kesin kayıtları · eski konuşmalar için tahmini API eşdeğeri":"Ajan Konseyi Antigravity kayıtları · API fiyat eşdeğeri");
  return {...result,estimatedHistory:estimated};
}
async function refreshProviderAccountUsage(){if(providerAccountUsageCache.refreshing||Date.now()-providerAccountUsageCache.at<5*60_000)return;providerAccountUsageCache.refreshing=true;try{const [codex,claude,antigravity]=await Promise.all([scanCodexAccountUsage(),scanClaudeAccountUsage(),scanAntigravityAccountUsage()]);providerAccountUsageCache={at:Date.now(),refreshing:false,value:{codex,claude,antigravity}};providerQuotaCache.at=0;}catch(error){providerAccountUsageCache.refreshing=false;console.error("Sağlayıcı kullanım geçmişi okunamadı:",error.message);}}
refreshProviderAccountUsage();
function newestFiles(root,suffix=".jsonl",limit=16){
  const files=[];
  const walk=(dir)=>{let entries=[];try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch{return;}for(const entry of entries){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(entry.name.endsWith(suffix)){try{const stat=fs.statSync(full);files.push({path:full,mtimeMs:stat.mtimeMs,size:stat.size});}catch{}}}};
  walk(root);return files.sort((a,b)=>b.mtimeMs-a.mtimeMs).slice(0,limit);
}
function providerQuotas(){
  if(Date.now()-providerQuotaCache.at<30000)return providerQuotaCache.value;
  const value={codex:{available:false},claude:{available:false},antigravity:{available:false}};
  for(const provider of ["claude","antigravity","codex"]){const accountUsage=providerAccountUsageCache.value[provider];if(accountUsage)value[provider]={...value[provider],accountUsage};}
  refreshProviderAccountUsage();
  const claudePlan=readClaudePlanQuota();
  if(claudePlan)value.claude={...value.claude,...claudePlan,accountUsage:value.claude.accountUsage||null};
  refreshAntigravityQuota();
  if(antigravityQuotaCache.value)value.antigravity={...value.antigravity,...antigravityQuotaCache.value,accountUsage:value.antigravity.accountUsage||null};
  try{
    const latestByLimit=new Map();
    for(const item of newestFiles(path.join(HOME,".codex","sessions"))){
      const size=Math.min(item.size,32*1024*1024),fd=fs.openSync(item.path,"r"),buffer=Buffer.alloc(size);fs.readSync(fd,buffer,0,size,item.size-size);fs.closeSync(fd);
      const lines=buffer.toString("utf8").split("\n").reverse();
      for(const line of lines){try{const event=JSON.parse(line),limits=event?.payload?.rate_limits||event?.payload?.info?.rate_limits,primary=limits?.primary;if(!primary||!Number.isFinite(primary.used_percent))continue;const timestamp=Date.parse(event.timestamp||0)||item.mtimeMs,limitId=String(limits.limit_id||"unknown");const previous=latestByLimit.get(limitId);if(!previous||timestamp>previous.timestamp)latestByLimit.set(limitId,{timestamp,event,limits,primary});}catch{}}
    }
    // `codex_bengalfox` gibi model-ozel limitler genel abonelik kotasi degildir.
    // Genel kaydi kimligiyle sec; yoksa yalnizca adsiz/model-ozel olmayan limiti kullan.
    const latest=latestByLimit.get("codex")||[...latestByLimit.values()].filter(item=>!item.limits.limit_name).sort((a,b)=>b.timestamp-a.timestamp)[0];
    if(latest){const {event,limits,primary}=latest,direct={name:"weekly",usedPercent:primary.used_percent,remainingPercent:Math.max(0,100-primary.used_percent),windowMinutes:primary.window_minutes||null,resetsAt:primary.resets_at?new Date(primary.resets_at*1000).toISOString():null,updatedAt:event.timestamp||null,stale:false,history:[]},meta={accountPlan:limits.plan_type||null,accountUsage:value.codex.accountUsage||null};value.codex={...meta,available:true,source:"Codex yerel oturum kaydı",limitId:limits.limit_id||null,limitName:limits.limit_name||"Genel Codex kotası",...direct,plan:limits.plan_type||null,credits:limits.credits||null,windows:[direct],secondary:limits.secondary&&Number.isFinite(limits.secondary.used_percent)?{name:"secondary",usedPercent:limits.secondary.used_percent,remainingPercent:Math.max(0,100-limits.secondary.used_percent),windowMinutes:limits.secondary.window_minutes||null,resetsAt:limits.secondary.resets_at?new Date(limits.secondary.resets_at*1000).toISOString():null,updatedAt:event.timestamp||null,stale:false,history:[]}:null};if(value.codex.secondary)value.codex.windows.push(value.codex.secondary);}
  }catch{}
  providerQuotaCache={at:Date.now(),value};return value;
}

const MIME = { ".html": "text/html", ".htm":"text/html", ".js": "text/javascript", ".css": "text/css", ".md": "text/markdown", ".svg":"image/svg+xml", ".png":"image/png", ".json":"application/json" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  try {
    // ---- Statik UI ----
    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      return serveFile(res, path.join(ROOT, "ui", "index.html"));
    }
    // commands.cjs: depo "type: module" oldugu icin testler ancak CJS dosyayi
    // require edebiliyor; tarayici icin ayni dosya /commands.js olarak sunulur.
    if (req.method === "GET" && p === "/commands.js") {
      return serveFile(res, path.join(ROOT, "ui", "commands.cjs"));
    }
    if (req.method === "GET" && (p === "/app.js" || p === "/style.css" || p === "/studio.css")) {
      return serveFile(res, path.join(ROOT, "ui", p));
    }
    if (req.method === "GET" && ["/assets/provider-claude.png","/assets/provider-codex.png","/assets/provider-antigravity.png"].includes(p)) {
      return serveFile(res, path.join(ROOT, p));
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
    // MCP koprusu yalniz uye ve proje listesine ihtiyac duyar. /api/state
    // kosu anlik goruntusuyle birlikte yarim megabayti asiyor; koprü her arac
    // cagrisinda onu cekmesin diye hafif ve sabit sozlesmeli bir uc verilir.
    // ---- Yedekleme ----
    if (req.method === "GET" && p === "/api/backup/status") {
      const configured = config.data.backup?.dir || null;
      return json(res, 200, {
        dir: configured,
        auto: config.data.backup?.auto !== false,
        googleDrive: detectGoogleDrive(HOME),
        last: lastBackupResult,
        running: backupRunning,
      });
    }
    if (req.method === "POST" && p === "/api/backup/config") {
      const body = await readBody(req);
      const dir = String(body.dir || "").trim();
      if (!dir) return json(res, 400, { error: "Yedek klasörü boş olamaz" });
      const resolved = path.resolve(dir.replace(/^~(?=\/|$)/, HOME));
      try { fs.mkdirSync(resolved, { recursive: true }); }
      catch (error) { return json(res, 400, { error: `Klasör oluşturulamadı: ${String(error.message || error)}` }); }
      config.data.backup = { dir: resolved, auto: body.auto !== false };
      config.save();
      return json(res, 200, { ok: true, dir: resolved });
    }
    if (req.method === "POST" && p === "/api/backup/run") {
      if (backupRunning) return json(res, 409, { error: "Yedekleme zaten sürüyor" });
      const dir = config.data.backup?.dir;
      if (!dir) return json(res, 400, { error: "Önce yedek klasörü seçin" });
      backupRunning = true;
      // 6+ GB ilk aynada istek dakikalarca askida kalmasin: is arka planda
      // kosar, sonuc /api/backup/status'tan okunur.
      Promise.resolve().then(() => runBackup(DATA_ROOT, dir))
        .then((result) => { lastBackupResult = result; })
        .catch((error) => { lastBackupResult = { at: new Date().toISOString(), error: String(error.message || error) }; })
        .finally(() => { backupRunning = false; });
      return json(res, 202, { started: true });
    }

    if (req.method === "GET" && p === "/api/mcp/info") {
      return json(res, 200, {
        members: (config.data.members || []).filter((m) => m.enabled)
          .map(({ id, name, provider, role, model }) => ({ id, name, provider, role, model })),
        projects: (config.data.projects || []).map(({ id, name, path: dir }) => ({ id, name, path: dir })),
      });
    }

    if (req.method === "GET" && p === "/api/state") {
      return json(res, 200, {
        ...store.snapshot(url.searchParams.get("run")),
        // Calisan gelistirme sunuculari: kenar cubugu projede canli oldugunu
        // gosterebilsin diye state ile birlikte yayinlanir.
        devServers: Object.fromEntries([...devSessions.entries()]
          .filter(([, session]) => session?.alive)
          .map(([projectId, session]) => [projectId, { alive: true, port: session.port || null, command: session.command || null }])),
        config: config.data,
        roles: ROLES,
        models: MODEL_CATALOG,
        efforts: EFFORT_LEVELS,
        home: HOME,
        capabilities: PROVIDER_CAPABILITIES,
        providerQuotas:providerQuotas(),
        workspaceState:workspaceState.public(),
      });
    }
    if(req.method==="GET"&&p==="/api/workspace")return json(res,200,workspaceState.public());
    if(req.method==="GET"&&p==="/api/api-providers/openrouter"){
      const status=await openRouterStatus();
      if(!status.configured&&config.data.apiProviders?.openrouter?.configured){
        const coordinator=config.data.coordinator?.provider==="openrouter"?{provider:"claude",model:"",effort:""}:config.data.coordinator;
        config.update({members:config.data.members.filter(member=>member.provider!=="openrouter"),coordinator,apiProviders:{openrouter:status}});
        store.emit("event",{type:"config"});
      }
      return json(res,200,status);
    }
    if(req.method==="POST"&&p==="/api/api-providers/openrouter"){
      const body=await readBody(req),key=String(body.apiKey||"").trim();
      if(!key)return json(res,400,{error:"API anahtarı gerekli"});
      try{const check=await fetch("https://openrouter.ai/api/v1/key",{headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(15000)});if(!check.ok){const detail=await check.json().catch(()=>({}));return json(res,400,{error:detail?.error?.message||"OpenRouter anahtarı doğrulanamadı"});}await saveOpenRouterKey(key);const persisted=await openRouterStatus();if(!persisted.configured)throw new Error("Anahtar doğrulandı ancak macOS Anahtar Zinciri'nden tekrar okunamadı");const members=config.data.members.filter(member=>member.provider!=="openrouter");members.push({id:"m-ox-alpha",name:"Ox Alpha",provider:"openrouter",role:"arastirmaci",model:"stealth/ox-alpha",effort:"",enabled:true});config.update({members,apiProviders:{openrouter:{configured:true}}});store.emit("event",{type:"config"});return json(res,200,{configured:true,provider:"openrouter",model:"stealth/ox-alpha",storage:"macOS Keychain"});}catch(error){return json(res,500,{error:String(error.message||error)});}
    }
    if(req.method==="DELETE"&&p==="/api/api-providers/openrouter"){await deleteOpenRouterKey();const coordinator=config.data.coordinator?.provider==="openrouter"?{provider:"claude",model:"",effort:""}:config.data.coordinator;config.update({members:config.data.members.filter(member=>member.provider!=="openrouter"),coordinator,apiProviders:{openrouter:{configured:false}}});store.emit("event",{type:"config"});return json(res,200,{configured:false});}
    if(req.method==="GET"&&p==="/api/workspace/leases")return json(res,200,{leases:workspaceState.activeLeases()});
    if(req.method==="POST"&&p==="/api/workspace/leases"){const body=await readBody(req);try{return json(res,201,workspaceState.acquireLease(body));}catch(error){return json(res,409,{error:error.message,conflict:error.conflict||null});}}
    const leaseApi=p.match(/^\/api\/workspace\/leases\/([\w-]+)$/);
    if(req.method==="PATCH"&&leaseApi){const body=await readBody(req);try{return json(res,200,workspaceState.renewLease(leaseApi[1],String(body.token||""),body.ttlMs));}catch(error){return json(res,403,{error:error.message});}}
    if(req.method==="DELETE"&&leaseApi){const body=await readBody(req);try{return json(res,200,{released:workspaceState.releaseLease(leaseApi[1],String(body.token||""))});}catch(error){return json(res,403,{error:error.message});}}
    const artifactExportApi=p.match(/^\/api\/runs\/([\w-]+)\/artifact-export$/);
    if(req.method==="POST"&&artifactExportApi){const run=store.getRun(artifactExportApi[1]);if(!run)return json(res,404,{error:"Koşu bulunamadı"});const project=config.getProject(run.projectId);if(!project)return json(res,400,{error:"Koşuya bağlı proje bulunamadı"});try{const result=exportRunArtifacts(project.path,run,{stage:"manual"});workspaceState.record("artifact.export",{runId:run.id,stage:"manual",relative:result.relative,files:result.files},project.id);return json(res,200,result);}catch(error){return json(res,400,{error:error.message});}}
    if(req.method==="POST"&&p==="/api/workspace/permissions"){const body=await readBody(req);return json(res,200,workspaceState.setPermissions(String(body.projectId||"global"),body.permissions||{}));}
    if(req.method==="GET"&&p==="/api/workspace/audit")return json(res,200,{audit:workspaceState.data.audit});
    if(req.method==="POST"&&p==="/api/workspace/schedules"){const body=await readBody(req),at=new Date(body.at);if(!body.request||Number.isNaN(+at))return json(res,400,{error:"Görev ve geçerli tarih gerekli"});const schedule={id:crypto.randomUUID(),request:String(body.request).slice(0,10000),projectId:body.projectId||null,at:at.toISOString(),status:"scheduled",createdAt:new Date().toISOString()};workspaceState.data.schedules.push(schedule);workspaceState.record("schedule.create",schedule,schedule.projectId);return json(res,201,schedule);}
    if(req.method==="POST"&&p==="/api/workspace/skills"){
      const body=await readBody(req);
      const skill={name:String(body?.name||"").trim(),version:String(body?.version||"1.0.0").trim()||"1.0.0",instructions:String(body?.instructions||"").trim(),command:String(body?.command||"").trim()};
      if(!skill.name)return json(res,400,{error:"Yetenek adı gerekli."});
      if(!skill.instructions&&!skill.command)return json(res,400,{error:"Talimat veya komut gerekli."});
      return json(res,200,workspaceState.saveSkill(skill));
    }
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
    if(req.method==="PATCH"&&runDetail){const run=store.getRun(runDetail[1]);if(!run)return json(res,404,{error:"Sohbet bulunamadı"});const body=await readBody(req);if("title" in body){run.title=String(body.title||"Yeni sohbet").trim().slice(0,80);run.titleManual=true;}if("pinned" in body)run.pinned=!!body.pinned;if("archived" in body)run.archived=!!body.archived;if("tags" in body)run.tags=Array.isArray(body.tags)?body.tags.map(x=>String(x).trim()).filter(Boolean).slice(0,12):[];if("deletedAt" in body)run.deletedAt=body.deletedAt?new Date().toISOString():null;if("sortIndex" in body)run.sortIndex=Number.isFinite(Number(body.sortIndex))?Number(body.sortIndex):null;if("projectId" in body){const project=body.projectId?config.getProject(body.projectId):null;run.projectId=project?.id||null;run.projectDir=project?.path||null;}store.updateRun(run);workspaceState.record("chat.update",{runId:run.id,fields:Object.keys(body)},run.projectId);return json(res,200,run);}
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
      // Kanonik yer once denenir: uretilen dosya artik bagli projenin icinde
      // yasar; Finder kullaniciya o kopyayi gostermelidir. Yol yalniz kayitli
      // bir proje dizininin ICINDEYSE kabul edilir. uploads yedegi korunur.
      const candidate = body.path ? path.resolve(String(body.path)) : null;
      // Kabul kapsami: kayitli proje dizinleri, veri dizini ve ev dizini.
      // "open -R" yalniz Finder'da gosterir; ev disina (sistem dosyalari)
      // isaret eden yollar yine de reddedilir.
      const inProject = candidate && ((config.data.projects || []).some((proj) => proj.path && isWithin(proj.path, candidate))
        || isWithin(DATA_ROOT, candidate) || isWithin(HOME, candidate));
      if (inProject && fs.existsSync(candidate)) {
        await execP("open", ["-R", candidate]);
        return json(res, 200, { ok:true, revealed: candidate });
      }
      const name = path.basename(String(body.url || body.name || ""));
      const file = path.join(DATA_ROOT, "uploads", name);
      if (!isWithin(path.join(DATA_ROOT, "uploads"), file) || !fs.existsSync(file)) return json(res, 404, { error:"Dosya bulunamadı" });
      await execP("open", ["-R", file]);
      return json(res, 200, { ok:true, revealed: file });
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

    // ---- Mesaj duzenle & yeniden calistir ----
    const rewindMatch = p.match(/^\/api\/runs\/([\w-]+)\/rewind$/);
    if (req.method === "POST" && rewindMatch) {
      const run = store.getRun(rewindMatch[1]);
      if (!run) return json(res, 404, { error: "Sohbet bulunamadı" });
      const body = await readBody(req);
      try {
        orch.rewindChat(run, String(body.messageId || ""), String(body.text || "").trim(), sanitizeAttachments(body.attachments)).catch(() => {});
        return json(res, 200, { ok: true, runId: run.id });
      } catch (error) { return json(res, 400, { error: String(error.message || error) }); }
    }

    // ---- Gunluk kota/kullanim ozeti (tum sohbetlerden bugunun toplami) ----
    if (req.method === "GET" && p === "/api/usage/today") {
      const gun = new Date().toISOString().slice(0, 10);
      const toplam = {};
      for (const run of Object.values(store.runs)) {
        const daily = run.usageDaily?.[gun];
        if (!daily) continue;
        for (const [uyeId, u] of Object.entries(daily)) {
          const uye = config.data.members.find((m) => m.id === uyeId);
          const anahtar = uye ? uye.provider : (uyeId === "koordinator" ? "koordinator" : uyeId);
          const b = (toplam[anahtar] ||= { input: 0, output: 0, calls: 0, costUsd: 0 });
          b.input += u.input || 0; b.output += u.output || 0; b.calls += u.calls || 0; b.costUsd += u.costUsd || 0;
        }
      }
      return json(res, 200, { day: gun, providers: toplam });
    }

    // ---- Uzak masaustu gozlem turu (Faz 1: yalniz okuma) ----
    if (req.method === "GET" && p === "/api/rdp/devices") {
      try { return json(res, 200, await rdp.listele()); }
      catch (error) { return json(res, 502, { error: String(error.message || error) }); }
    }
    // Gozlem turunun TAM kaydi: zaman cizelgesi, kanitlar, bulgular, planlar.
    // Sohbet bicimi degil — bu isin kendi gorunumu var.
    const turMatch = p.match(/^\/api\/rdp\/run\/([\w-]+)$/);
    if (req.method === "GET" && turMatch) {
      const run = store.getRun(turMatch[1]);
      if (!run || run.kind !== "ops") return json(res, 404, { error: "Gözlem turu bulunamadı" });
      const hedef = String(run.request || "").replace(/^Gözlem turu:\s*/, "");
      const durum = rdp.durum(hedef);
      return json(res, 200, {
        id: run.id, target: hedef, createdAt: run.createdAt,
        state: durum || null,
        adimlar: (run.messages || []).map((m) => ({
          at: m.ts, from: m.from, fromLabel: m.fromLabel || null, kind: m.kind,
          content: m.content, attachments: (m.attachments || []).map((a) => ({ name: a.name, url: a.url })),
        })),
      });
    }
    // Tum gozlem turlari (en yeniden eskiye) — bolumun listesi.
    if (req.method === "GET" && p === "/api/rdp/runs") {
      const turlar = Object.values(store.runs)
        .filter((r) => r.kind === "ops" && !r.deletedAt)
        .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
        .slice(0, 50)
        .map((r) => {
          const hedef = String(r.request || "").replace(/^Gözlem turu:\s*/, "");
          const d = rdp.durum(hedef);
          return { id: r.id, target: hedef, createdAt: r.createdAt,
            connection_state: d?.connection_state || null,
            bulgu: (d?.findings || []).length, adim: (r.messages || []).length };
        });
      return json(res, 200, { turlar });
    }

    // Faz durumu ve is turu acma/kapatma.
    if (req.method === "GET" && p === "/api/rdp/faz") {
      // Arayuz risk rozetlerini buradan alir: tek kaynak OYUN_KITABI.
      const turlar = Object.fromEntries(Object.entries(OYUN_KITABI)
        .map(([k, v]) => [k, { ad: v.ad, risk: v.risk }]));
      return json(res, 200, { ...opsFaz.durum(), turlar });
    }
    if (req.method === "POST" && p === "/api/rdp/faz") {
      const body = await readBody(req);
      try {
        if (body.isTuru) {
          if (body.kapat) opsFaz.turKapat(body.isTuru);
          else opsFaz.turAc(body.isTuru);
        } else if (body.ustSinir !== undefined) {
          opsFaz.ac(body.ustSinir);
        }
        return json(res, 200, opsFaz.durum());
      } catch (error) { return json(res, 400, { error: String(error.message || error) }); }
    }
    // Guvenlik kapilari: acil durdurma, devre kesici, politika dogrulama.
    if (req.method === "GET" && p === "/api/rdp/guvenlik") {
      return json(res, 200, {
        acilDurdurma: { aktif: opsKill.aktifMi(), sebep: opsKill.aktifMi() ? opsKill.sebep() : null, dosya: opsKill.dosya },
        kesiciler: opsKesici.hepsi(),
        politika: opsPolitika.durum(),
      });
    }
    if (req.method === "POST" && p === "/api/rdp/dur") {
      const body = await readBody(req);
      if (body.kaldir) opsKill.kaldir();
      else opsKill.bas(String(body.sebep || "arayüzden durduruldu"));
      return json(res, 200, { aktif: opsKill.aktifMi() });
    }
    if (req.method === "POST" && p === "/api/rdp/politika") {
      const body = await readBody(req);
      if (body.geriAl) return json(res, 200, opsPolitika.geriAl(body.isTuru));
      const sonuc = opsPolitika.dogrula(body.isTuru, body);
      return json(res, sonuc.ok ? 200 : 400, sonuc);
    }
    if (req.method === "GET" && p === "/api/rdp/metrik") {
      return json(res, 200, opsMetrikleri(opsJobs.liste(),
        { izleyici: opsWatcher.durum(), kesici: opsKesici, politika: opsPolitika }));
    }
    // Canli izleyici: CanSellerAI panelini yoklar, yeni kayitlari ise cevirir.
    if (req.method === "GET" && p === "/api/rdp/watcher") {
      return json(res, 200, opsWatcher.durum());
    }
    if (req.method === "POST" && p === "/api/rdp/watcher") {
      const body = await readBody(req);
      if (body.durdur) return json(res, 200, { ...opsWatcher.durdur(), ...opsWatcher.durum() });
      const sonuc = opsWatcher.baslat(body.hesap || null);
      return json(res, sonuc.ok ? 200 : 400, { ...sonuc, ...opsWatcher.durum() });
    }
    if (req.method === "POST" && p === "/api/rdp/watcher/yokla") {
      try { return json(res, 200, opsWatcher.hesap ? await opsWatcher.yokla() : await opsWatcher.tumunuYokla()); }
      catch (error) { return json(res, 502, { error: String(error.message || error) }); }
    }
    // Serbest metin komutu: "WOOY'a gir gecilmeyen siparisleri gec" gibi.
    if (req.method === "POST" && p === "/api/rdp/komut") {
      const body = await readBody(req);
      const metin = String(body.metin || "").trim();
      if (!metin) return json(res, 400, { error: "Komut boş" });
      let cihazlar = [];
      try { cihazlar = (await rdp.listele()).devices; } catch { /* liste yoksa magaza cozulemez */ }
      const uyeler = (config.data.members || []).filter((m) => m.enabled);
      let cozum = komutCoz(metin, { uyeler, cihazlar });

      // Kural cozemediyse SECILEN uye yorumlar. Kullanici: "bunu yapay zeka
      // bakmalı; hangi yapay zekanın bakacağına karar veren ben olmalıyım."
      // Uye serbest degil: yalniz kayitli magaza ve tanimli is turu
      // listesinden secebilir, dusuk guvende reddedilir.
      if (!cozum.ok) {
        const secilen = uyeler.find((u) => u.id === (cozum.uye?.id || body.memberId)) || uyeler[0];
        if (secilen) {
          const isTurleri = Object.fromEntries(
            Object.entries(OYUN_KITABI).map(([k, v]) => [k, v.ad || k]));
          try {
            const run = store.createRun({ kind: "ops", request: `Komut yorumu: ${metin.slice(0, 60)}`,
              mode: "auto", agents: [secilen.id], projectId: null, projectDir: null, attachments: [] });
            // Yorum kosusu GECICIDIR: tek bir soru sorulur, cevap alinir,
            // biter. Uygulama bu sirada kapanirsa "kaldigi yerden devam"
            // onu normal bir konsey kosusu sanip koordinatoru calistiriyor
            // ve bos yere uye tuketiyordu (canli goruldu).
            run.autoResume = false;
            const yanit = await orch.callMember(run, secilen,
              yorumIstemi(metin, { cihazlar, isTurleri }),
              { isolated: true, label: "komut yorumu", timeoutMs: 60_000 });
            run.status = "idle";
            const dogru = yorumDogrula(jsonAyikla(String(yanit?.text || "")), { cihazlar, isTurleri });
            if (dogru.ok) {
              cozum = komutCoz(`${dogru.magaza} ${metin}`, { uyeler, cihazlar });
              if (!cozum.ok || cozum.isTuru !== dogru.isTuru) {
                // Yorum is turunu farkli okuduysa onu esas al.
                cozum = { ...cozum, ok: true, magaza: dogru.magaza, isTuru: dogru.isTuru,
                  isAdi: isTurleri[dogru.isTuru] || dogru.isTuru,
                  risk: OYUN_KITABI[dogru.isTuru]?.risk ?? 3, eksik: [],
                  ozet: `${dogru.magaza} · ${isTurleri[dogru.isTuru]}${secilen ? ` · ${secilen.name}` : ""}` };
              }
              cozum.yorumlayan = secilen.name;
              cozum.yorumNedeni = dogru.neden;
            } else {
              cozum.yorumHatasi = dogru.mesaj;
              cozum.yorumlayan = secilen.name;
            }
          } catch (hata) {
            cozum.yorumHatasi = `Yorumlanamadı: ${String(hata.message || hata)}`;
          }
        }
      }
      if (!cozum.ok) return json(res, 200, { ...cozum, calistirildi: false });
      // Cozulen komut ISE donusur; faz kapisi ve onay kurallari aynen gecerli.
      const varlik = cozum.kimlik || `komut-${Date.now()}`;
      const ekle = opsJobs.ekle({ isTuru: cozum.isTuru, hesap: cozum.magaza, varlikId: varlik,
        risk: cozum.risk, veri: { ozet: cozum.ham, kaynak: "kullanıcı komutu", uye: cozum.uye } });
      // Yurutulebilir mi? Faz kapisi kapaliysa is kuyrukta bekler.
      const izinli = opsFaz.izinliMi(cozum.risk, cozum.isTuru);
      if (ekle.ok && izinli && !opsRun.aktif) {
        opsRun.gozlemle(cozum.magaza, { memberId: cozum.uye?.id || body.memberId || null, not: metin })
          .catch(() => {});
      }
      return json(res, 200, { ...cozum, calistirildi: Boolean(ekle.ok && izinli && !opsRun.aktif),
        yinelenen: Boolean(ekle.yinelenen), isId: ekle.is?.id || null,
        kapali: !izinli, kapaliMesaj: izinli ? null : `"${cozum.isAdi}" işleri şu an kapalı — Yetkiler'den açın.` });
    }
    if (req.method === "GET" && p === "/api/rdp/jobs") {
      return json(res, 200, { isler: opsJobs.liste(), uzlastirma: opsJobs.uzlastirmaBekleyenler().length });
    }
    if (req.method === "GET" && p === "/api/rdp/state") {
      return json(res, 200, opsRun.durum());
    }
    if (req.method === "POST" && p === "/api/rdp/observe") {
      const body = await readBody(req);
      const hedef = String(body.target || "").trim();
      if (!hedef) return json(res, 400, { error: "Hedef cihaz adı gerekli" });
      // Tur arka planda yurur; arayuz /api/rdp/state ile izler.
      opsRun.gozlemle(hedef, { memberId: body.memberId || null, not: String(body.not || "").slice(0, 400) })
        .catch((error) => store.emit("event", { type: "ops_error", error: String(error.message || error) }));
      return json(res, 202, { ok: true, target: hedef });
    }
    // Sunucu adresi onayi: kullanici "bu adres dogru" derse cihaza sabitlenir.
    if (req.method === "POST" && p === "/api/rdp/approve-host") {
      const body = await readBody(req);
      const hedef = String(body.target || "").trim();
      const host = String(body.host || "").trim();
      if (!hedef || !host) return json(res, 400, { error: "Cihaz ve adres gerekli" });
      const pin = rdp.pinYaz(hedef, host);
      opsRun.bekleyenOnay = null;
      return json(res, 200, { ok: true, pin });
    }
    if (req.method === "POST" && p === "/api/rdp/reset-host") {
      const body = await readBody(req);
      rdp.pinSil(String(body.target || "").trim());
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && p === "/api/rdp/hosts") {
      return json(res, 200, rdp.pinleriOku());
    }

    if (req.method === "POST" && p === "/api/rdp/stop") {
      opsRun.iptalEt();
      return json(res, 200, { ok: true });
    }

    // ---- Operasyon Merkezi (CanSellerAI) — FAZ 1: YALNIZ OKUMA ----
    // Oturum cerezi burada, sunucu katmaninda kalir; ne arayuze ne de konsey
    // uyelerine gecer. Uyeler yalniz temizlenmis veri gorur (temizleKayit).
    if (req.method === "GET" && p === "/api/ops/status") {
      return json(res, 200, canseller.status());
    }
    if (req.method === "POST" && p === "/api/ops/connect") {
      const body = await readBody(req);
      if (body.serviceKey) { canseller.setServiceKey(String(body.serviceKey)); return json(res, 200, canseller.status()); }
      try {
        await canseller.login(body.login, body.password);
        return json(res, 200, canseller.status());
      } catch (error) { return json(res, 401, { error: String(error.message || error) }); }
    }
    if (req.method === "POST" && p === "/api/ops/disconnect") {
      canseller.cikis(); canseller.setServiceKey(null);
      return json(res, 200, canseller.status());
    }
    if (req.method === "GET" && p === "/api/ops/accounts") {
      try { return json(res, 200, await canseller.accounts()); }
      catch (error) { return json(res, 502, { error: String(error.message || error) }); }
    }
    if (req.method === "POST" && p === "/api/ops/switch") {
      const body = await readBody(req);
      try { return json(res, 200, await canseller.switchAccount(body.id)); }
      catch (error) { return json(res, 502, { error: String(error.message || error) }); }
    }
    if (req.method === "GET" && p === "/api/ops/overview") {
      try { return json(res, 200, await canseller.overview()); }
      catch (error) { return json(res, 502, { error: String(error.message || error) }); }
    }

    // ---- Golge modu: uye YORUMLAR, hicbir sey YAPMAZ ----
    // Dokumandaki "shadow mode" adimi: YZ ne yapilmasi gerektigini soyler ama
    // tiklamaz. Uyeye giden veri temizlenmis ve KISITLIDIR; arac/koprulerin
    // hepsi kapalidir (isolated), yani bu cagri disariya hicbir eylem yapamaz.
    if (req.method === "POST" && p === "/api/ops/assess") {
      const body = await readBody(req);
      const kayitlar = Array.isArray(body.items) ? body.items.slice(0, 25).map((x) => temizleKayit(x)) : [];
      if (!kayitlar.length) return json(res, 400, { error: "Değerlendirilecek kayıt yok" });
      const uye = config.data.members.find((m) => m.enabled && (!body.memberId || m.id === body.memberId));
      if (!uye) return json(res, 400, { error: "Etkin üye yok" });
      const istem = `Sen bir e-ticaret operasyon analistisin. Aşağıdaki CanSellerAI kayıtlarını (eBay iadeleri / davalar / sipariş müdahaleleri) İNCELE ve her biri için kısa bir değerlendirme yaz.

GÖLGE MODU: Bu bir tavsiye turudur. Hiçbir işlem yapılmayacak, hiçbir düğmeye basılmayacak. Sen yalnız NE YAPILMASI GEREKTİĞİNİ söylüyorsun.

Her kayıt için şu üç şeyi ver:
1. Durum özeti (tek cümle, Türkçe)
2. Önerilen işlem (tek cümle) — yapılabilir somut adım
3. Risk seviyesi: 0 okuma/kanıt, 1 taslak hazırlama, 2 politika uygunsa otomatik (takip kodu, ücretsiz etiket), 3 sipariş verme/iade başlatma (onay gerekir), 4 para iadesi/ücretli kargo/dava gönderimi (her seferinde onay)

Belirsizlik varsa "bilgi eksik" de ve neyin eksik olduğunu yaz; tahmin uydurma. Alıcı adı/adresi gizlenmiştir, onları isteme.

KAYITLAR (JSON):
${JSON.stringify(kayitlar, null, 1).slice(0, 60000)}`;
      try {
        const run = store.createRun({ kind: "chat", request: "Operasyon değerlendirmesi (gölge modu)", mode: "auto",
          agents: [uye.id], projectId: null, projectDir: null, attachments: [] });
        run.status = "idle"; run.title = `🛡 Gölge değerlendirme · ${kayitlar.length} kayıt`;
        const sonuc = await orch.callMember(run, uye, istem, { isolated: true, label: "gölge değerlendirme", timeoutMs: 240_000 });
        store.addMessage(run, { from: "kullanici", kind: "message", content: `Gölge modu değerlendirmesi: ${kayitlar.length} kayıt` });
        store.addMessage(run, { from: uye.id, fromLabel: uye.name, provider: uye.provider, kind: "message",
          content: String(sonuc.text || "").slice(0, 16000) });
        store.updateRun(run, { status: "idle", phase: "idle" });
        return json(res, 200, { runId: run.id, ok: sonuc.ok !== false, text: String(sonuc.text || "").slice(0, 16000) });
      } catch (error) { return json(res, 500, { error: String(error.message || error) }); }
    }

    // ---- Sesli giris: WAV -> metin (yerel, macOS konusma tanima) ----
    if (req.method === "POST" && p === "/api/speech") {
      const chunks = [];
      let boyut = 0;
      for await (const chunk of req) {
        boyut += chunk.length;
        if (boyut > 12 * 1024 * 1024) return json(res, 413, { error: "Ses kaydı çok uzun (en fazla ~2 dakika)." });
        chunks.push(chunk);
      }
      try {
        const metin = await speech.transcribe(Buffer.concat(chunks), { tmpDir: path.join(DATA_ROOT, "uploads") });
        return json(res, 200, { text: metin });
      } catch (error) {
        return json(res, 500, { error: String(error.message || error) });
      }
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
    const healthMatch=p.match(/^\/api\/projects\/([\w-]+)\/health$/);
    if(req.method==="GET"&&healthMatch){const project=config.getProject(healthMatch[1]);if(!project)return json(res,404,{error:"Proje bulunamadı"});let score=35;const checks=[];const add=(label,ok,points,advice)=>{if(ok)score+=points;checks.push({label,ok,points,advice});};let pkg={};try{pkg=JSON.parse(fs.readFileSync(path.join(project.path,"package.json"),"utf8"));}catch{}add("Proje tanımı",!!pkg.name,10,"package.json veya eşdeğer proje tanımı ekleyin");add("Otomatik test",!!(pkg.scripts?.test||project.testCommand),20,"Tek komutla çalışan test akışı tanımlayın");add("Geliştirme sunucusu",!!(pkg.scripts?.dev||pkg.scripts?.start||project.devCommand),10,"dev/start komutu tanımlayın");add("Dokümantasyon",fs.existsSync(path.join(project.path,"README.md")),10,"README ekleyin");add("Sürüm kontrolü",fs.existsSync(path.join(project.path,".git")),10,"Git deposu başlatın");const related=Object.values(store.runs||{}).filter(run=>run.projectId===project.id),lastTests=related.flatMap(run=>run.tests||[]).slice(-5);add("Son test sonuçları",lastTests.length>0&&lastTests.every(test=>test.ok),5,"Başarısız veya eksik testleri giderin");return json(res,200,{score:Math.min(100,score),grade:score>=90?"Mükemmel":score>=75?"İyi":score>=55?"Geliştirilmeli":"Riskli",checks,updatedAt:new Date().toISOString()});}
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
        excludedProviders: normalizeExcludedProviders([...(Array.isArray(body.excludedProviders) ? body.excludedProviders : []), ...excludedProvidersFromText(body.request)]),
      });
      run.testFirst = !!body.testFirst;
      run.budget={enabled:body.budget?.enabled===true,maxCalls:Math.max(1,Math.min(Number(body.budget?.maxCalls)||24,200)),maxTokens:Math.max(1000,Number(body.budget?.maxTokens)||250000),stopped:false};
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
      let createdConversation = false;
      if (run && run.kind !== "chat") run = null;
      const approach = ["quick", "pair", "council"].includes(body.approach) ? body.approach : null;
      const intensity = ["ekonomik", "dengeli", "titiz"].includes(body.intensity) ? body.intensity : null;
      if (run?.turnActive) {
        // Tur CALISIRKEN gelen mesaj kuyruga degil isin ICINE gider: bir
        // sonraki uye cagrisinda "ara yonlendirme" olarak islenir; sistem
        // kaldigi yeri bilir, is birakilmaz. (Kullanici istegi: "arada fikir
        // verebilirim, sistem onceki kaldigi yeri bilir".)
        run.steeringNotes = [...(run.steeringNotes || []), text];
        store.addMessage(run, { from: "kullanici", kind: "message", content: text, attachments: sanitizeAttachments(body.attachments) });
        store.addMessage(run, { from: "sistem", kind: "info", content: "↪ Mesaj çalışan tura iletildi; üyeler bir sonraki adımda dikkate alacak." });
        store.updateRun(run);
        return json(res, 202, { runId: run.id, steered: true });
      }
      if (run?.directActive) {
        const chatMode = ["auto", "discussion", "split", "code"].includes(body.mode) ? body.mode : "auto";
        const queued = orch.enqueueMessage(run, {
          target: "konsey", text, mode: chatMode, approach, intensity,
          attachments: sanitizeAttachments(body.attachments),
        });
        return json(res, 202, { runId: run.id, queued: true, queueId: queued.id });
      }

      if (!run) {
        createdConversation = true;
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
          excludedProviders: normalizeExcludedProviders([...(Array.isArray(body.excludedProviders) ? body.excludedProviders : []), ...excludedProvidersFromText(text)]),
        });
        run.status = "idle";
        run.title = conversationTitle(text);
      }
      if (body.testCommand?.trim()) run.testCommand = body.testCommand.trim();
      run.budget={enabled:body.budget?.enabled===true,maxCalls:Math.max(1,Math.min(Number(body.budget?.maxCalls)||24,200)),maxTokens:Math.max(1000,Number(body.budget?.maxTokens)||250000),stopped:false,reason:null};
      run.testFirst = !!body.testFirst;
      const chatMode = ["auto", "discussion", "split", "code"].includes(body.mode) ? body.mode : "auto";
      orch.continueChat(run, text, sanitizeAttachments(body.attachments), chatMode, { approach, intensity })
        .then(()=>createdConversation?orch.generateConversationTitle(run,text):null)
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
      orch.directMessage(run, member.id, text, sanitizeAttachments(body.attachments))
        .then(()=>orch.generateConversationTitle(run,text))
        .catch((err) => {
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

    // ---- Oturum tazeleme (bağlam bütçesi) ----
    const refreshMatch = p.match(/^\/api\/runs\/([\w-]+)\/session\/refresh$/);
    if (req.method === "POST" && refreshMatch) {
      const run = store.getRun(refreshMatch[1]);
      if (!run) return json(res, 404, { error: "Koşu bulunamadı" });
      const body = await readBody(req);
      try {
        const result = await orch.refreshMemberSession(run, body.memberId);
        return json(res, 200, result);
      } catch (e) {
        return json(res, 400, { error: String(e.message || e) });
      }
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

// MCP koprusu ayri bir surectir ve portu/belirteci onceden bilemez. Sunucu
// bunlari veri dizinine yazar; koprü okur. Dosya yalniz kullaniciya okunur
// izinle olusturulur, cunku belirtec icerir.
let lastBackupResult = null;
let backupRunning = false;
// Saatlik otomatik yedek: hedef ayarliysa ve onceki tur bitmisse calisir.
// Ayna artimli oldugu icin sessiz turlarda maliyet birkac stat cagrisidir.
setInterval(() => {
  const dir = config.data.backup?.dir;
  if (!dir || config.data.backup?.auto === false || backupRunning) return;
  backupRunning = true;
  Promise.resolve().then(() => runBackup(DATA_ROOT, dir))
    .then((result) => { lastBackupResult = result; })
    .catch((error) => { lastBackupResult = { at: new Date().toISOString(), error: String(error.message || error) }; })
    .finally(() => { backupRunning = false; });
}, 60 * 60 * 1000);

const MCP_ENDPOINT_FILE = path.join(DATA_ROOT, "mcp-endpoint.json");
function writeMcpEndpoint() {
  try {
    fs.mkdirSync(DATA_ROOT, { recursive: true });
    fs.writeFileSync(MCP_ENDPOINT_FILE,
      JSON.stringify({ port: Number(PORT), token: UI_TOKEN || null, pid: process.pid, at: new Date().toISOString() }),
      { mode: 0o600 });
  } catch { /* el sikisma dosyasi yazilamazsa sunucu yine de calisir */ }
}
function removeMcpEndpoint() { try { fs.unlinkSync(MCP_ENDPOINT_FILE); } catch {} }
for (const signal of ["exit", "SIGINT", "SIGTERM"]) {
  process.on(signal, () => { removeMcpEndpoint(); if (signal !== "exit") process.exit(0); });

// EMNIYET AGI: tek bir gorevdeki yakalanmamis hata TUM konseyi oldurmesin.
// Canli cokme: 52 MB'lik git diff maxBuffer asti, istisna yukari kacti ve
// surec exit=1 ile oldu; calisan kosu yarim kaldi. Burada gunluge yazilir
// ve surec YASAMAYA DEVAM eder — kosulari olduren sey hatanin kendisi
// degil, surecin olmesiydi.
process.on("uncaughtException", (hata) => {
  console.error("[emniyet-agi] yakalanmamış hata:", hata?.stack || hata);
});
process.on("unhandledRejection", (hata) => {
  console.error("[emniyet-agi] sahipsiz reddetme:", hata?.stack || hata);
});

}

// ---- Zamanlanmis gorevler ----
// Dakikada bir bakilir: saati gelmis, bugun kosmamis ve etkin her gorev icin
// yeni bir sohbet acilip istem konseye verilir. Sunucu kapaliyken kacan saat
// telafi EDILMEZ (kullanici gorevi elle kosabilir) — surpriz maliyet olmasin.
function runSchedules() {
  const simdi = new Date();
  const saat = `${String(simdi.getHours()).padStart(2, "0")}:${String(simdi.getMinutes()).padStart(2, "0")}`;
  const gun = simdi.toISOString().slice(0, 10);
  let degisti = false;
  for (const sch of config.data.schedules || []) {
    if (!sch.enabled || !sch.prompt || sch.lastRunDay === gun || sch.time !== saat) continue;
    sch.lastRunDay = gun; degisti = true;
    const project = sch.projectId ? config.getProject(sch.projectId) : null;
    const enabled = config.data.members.filter((m) => m.enabled).map((m) => m.id);
    if (!enabled.length) continue;
    const run = store.createRun({
      kind: "chat", request: sch.prompt, mode: sch.mode || "auto", agents: enabled,
      projectId: project?.id || null, projectDir: project?.path || null, attachments: [],
    });
    run.status = "idle";
    run.title = `⏰ ${sch.name}`;
    store.addMessage(run, { from: "sistem", kind: "info", content: `⏰ Zamanlanmış görev "${sch.name}" (${sch.time}) başlatıldı.` });
    orch.continueChat(run, sch.prompt, [], sch.mode || "auto").catch(() => {});
  }
  if (degisti) config.save();
}
setInterval(runSchedules, 60 * 1000);

server.listen(PORT, "127.0.0.1", () => {
  writeMcpEndpoint();
  console.log(`Ajan Konseyi hazır → http://localhost:${PORT}`);
  console.log(`Antigravity köprü talimatı: bridge/antigravity/INSTRUCTIONS.md`);
  // Açılışta ve her 10 dakikada bir CLI sağlık kontrolü
  orch.checkHealth().catch(() => {});
  // autoResume kapisi yeter: sohbet kosulari varsayilan autoResume=false,
  // yalniz GOREV ORTASINDA kesilenler store tarafindan acikca isaretlenir.
  setTimeout(()=>{for(const run of Object.values(store.runs)){if(run.status==="interrupted"&&run.autoResume)orch.resumeRun(run);}},3500);
  setInterval(() => orch.checkHealth().catch(() => {}), 10 * 60 * 1000);
});
