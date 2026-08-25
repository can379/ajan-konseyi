const { app, BrowserWindow, shell, Menu, dialog, clipboard, nativeImage, net, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const os = require("node:os");
const { SENSITIVE_FIELD_SNIPPET } = require("../src/browserFieldPolicy.cjs");

// Release/package names may change, but durable project settings must always
// use the same application profile.
app.setName("Ajan Konseyi");
app.setPath("userData", path.join(app.getPath("appData"), "Ajan Konseyi"));

const root = path.resolve(__dirname, "..");
const sourceRoot = app.isPackaged ? path.resolve(process.resourcesPath, "../../../../..") : root;
let serverProcess = null;
const { openServerLog, nextRespawnDelay } = require("./serverGuard.cjs");
let serverLog = null;      // tembel acilir: app.getPath "ready" ister
let quittingApp = false;   // kasitli kapanista bekci yeniden dogurtmaz
let respawnAttempts = 0;
let respawnTimer = null;
let mainWindow = null;
let browserGuest = null;
const browserGuests = new Map();
let browserPoll = null;
let browserPollInFlight = false;
// Açılışı bekleyen komutun beklenen origin'i. Yönlendirme COMMIT EDİLMEDEN
// karşılaştırılır; yükleme sonrası kontrol geç kalıyordu (çerez/istek gitmiş olur).
let expectedBrowserOrigin = null;
// Kilidin süresi. Paylaşım bittikten sonra kilit kalkmalı: aksi hâlde ajan bir kez
// origin paylaştıktan sonra o sekme kalıcı olarak o siteye hapsoluyor ve KULLANICININ
// kendi gezinmesi de engelleniyordu (SSO/Google ile giriş gibi akışlar tamamen kırılır).
let expectedBrowserOriginUntil = 0;
let activeFlowVideoRunId = null;
const downloadSessions = new WeakSet();
let flowLoginWindow = null;
let flowWorkerWindow = null;
let flowWorkerBusy = false;
let flowAccountCheckPromise = null;
const FLOW_URL = "https://labs.google/fx/tr/tools/flow";
const FLOW_PARTITION = "persist:ajan-flow";
const FLOW_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FLOW_CHROME_PROFILE = path.join(app.getPath("userData"),"flow-chrome-profile");
function releaseBrowserOriginLockIfExpired(){if(expectedBrowserOrigin&&Date.now()>expectedBrowserOriginUntil){expectedBrowserOrigin=null;expectedBrowserOriginUntil=0;}}
const browserReadyWaiters = new Map();
const uiToken = crypto.randomBytes(32).toString("base64url");
const bridgeToken = crypto.randomBytes(32).toString("base64url");
process.env.AJAN_UI_TOKEN = uiToken;

function allowedBrowserUrl(value) { try { const url=new URL(value); return url.protocol==="https:"||(url.protocol==="http:"&&["localhost","127.0.0.1","::1"].includes(url.hostname)); } catch { return false; } }
// Commit öncesi origin kilidi: protokol tek başına yetmez, HTTPS bir saldırgan
// origin'ine yönlendirme de engellenmelidir. Beklenen origin yoksa yalnız
// protokol denetlenir (kullanıcının elle gezinmesi kısıtlanmaz).
function browserNavigationAllowed(value) {
  if (!allowedBrowserUrl(value)) return false;
  if (!expectedBrowserOrigin) return true;
  try { return new URL(value).origin === expectedBrowserOrigin; } catch { return false; }
}
const bridgeHeaders={Authorization:`Bearer ${bridgeToken}`,"Content-Type":"application/json"};
const snapshotScript=`(() => { const expected=__ORIGIN__; if(location.origin!==expected)throw new Error('Origin snapshot öncesinde değişti'); ${SENSITIVE_FIELD_SNIPPET} const clone=document.documentElement.cloneNode(true); clone.querySelectorAll('script,style,noscript,template,svg,canvas,input,textarea,select,[contenteditable],[data-private]').forEach((node)=>node.remove()); const nodes=[...document.querySelectorAll('a[href],button,[role=button],input,textarea,[contenteditable=true]')].filter((node)=>{const rect=node.getBoundingClientRect();return rect.width>0&&rect.height>0&&!sensitive(node)}); const elements=nodes.slice(0,200).map((node,index)=>({id:'e'+index,role:node.tagName.toLowerCase(),label:(node.innerText||node.getAttribute('aria-label')||node.getAttribute('placeholder')||'').replace(/\\s+/g,' ').trim().slice(0,300)})); return {title:document.title,url:location.href,origin:location.origin,text:(clone.innerText||clone.textContent||'').replace(/\\s+/g,' ').trim(),elements}; })()`;
function elementActionScript(command){const index=Number(String(command.payload?.elementId||"").replace(/^e/,""));const text=JSON.stringify(String(command.payload?.text||""));const operation=command.action==="click"?"node.click();":`if(sensitive(node))throw new Error('Kimlik, doğrulama veya ödeme alanlarına ajan yazamaz');if(!node.matches('input,textarea,[contenteditable=true]'))throw new Error('Güvenli yazma hedefi değil');node.focus();if('value'in node)node.value=${text};else node.textContent=${text};node.dispatchEvent(new Event('input',{bubbles:true}));`;return `(()=>{if(location.origin!==${JSON.stringify(command.origin)})throw new Error('Origin değişti');${SENSITIVE_FIELD_SNIPPET}const nodes=[...document.querySelectorAll('a[href],button,[role=button],input,textarea,[contenteditable=true]')].filter((node)=>{const rect=node.getBoundingClientRect();return rect.width>0&&rect.height>0&&!sensitive(node)});const node=nodes[${index}];if(!node)throw new Error('Hedef öğe artık görünür değil');${operation}return{ok:true,url:location.href};})()`;}
async function sendBridgeResult(body){return net.fetch("http://127.0.0.1:4780/api/browser/bridge/result",{method:"POST",headers:bridgeHeaders,body:JSON.stringify(body)});}
function waitForBrowserReady(id){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{browserReadyWaiters.delete(id);reject(new Error("Tarayıcı paneli hazır olmadı"));},5000);browserReadyWaiters.set(id,()=>{clearTimeout(timer);browserReadyWaiters.delete(id);resolve();});});}
function waitForBrowserGuest(){return new Promise((resolve,reject)=>{if(browserGuest&&!browserGuest.isDestroyed())return resolve(browserGuest);const started=Date.now();const timer=setInterval(()=>{if(browserGuest&&!browserGuest.isDestroyed()){clearInterval(timer);resolve(browserGuest);}else if(Date.now()-started>=5000){clearInterval(timer);reject(new Error("Tarayıcı webview'i oluşturulamadı"));}},25);});}
function ensureBrowserPoll(){if(!browserPoll)browserPoll=setInterval(pollBrowserCommands,250);}
// Gönderen doğrulaması: yalnız ana pencerenin webContents'i bir açılışı çözebilir.
// Bugün webview'a preload verilmediği için (ui/app.js) misafir sayfanın ipcRenderer'a
// erişimi yok; bu kontrol derinlemesine savunmadır — ileride ikinci bir pencere veya
// webview preload'u eklenirse yetkisiz çözümlemeyi engeller.
ipcMain.on("browser-ready",(event,id)=>{
  if(!mainWindow||mainWindow.isDestroyed()||event.sender!==mainWindow.webContents)return;
  browserReadyWaiters.get(String(id))?.();
});
ipcMain.on("browser-active-guest",(event,id)=>{
  if(!mainWindow||mainWindow.isDestroyed()||event.sender!==mainWindow.webContents)return;
  const guest=browserGuests.get(Number(id));
  if(guest&&!guest.isDestroyed())browserGuest=guest;
});
ipcMain.on("flow-video-begin",(event,detail)=>{
  if(!mainWindow||event.sender!==mainWindow.webContents)return;
  activeFlowVideoRunId=String(detail?.runId||"")||null;
  if(detail?.prompt)clipboard.writeText(String(detail.prompt));
});
async function importFlowVideo(runId,filePath){
  const response=await net.fetch(`http://127.0.0.1:4780/api/flow-video-runs/${encodeURIComponent(runId)}/import-path`,{method:"POST",headers:{"Content-Type":"application/json","X-Ajan-UI-Token":uiToken},body:JSON.stringify({path:filePath})});
  const result=await response.json(); if(!response.ok)throw new Error(result.error||"Video içe aktarılamadı"); return result;
}
async function reportFlowFailure(runId,error){
  await net.fetch(`http://127.0.0.1:4780/api/flow-video-runs/${encodeURIComponent(runId)}/fail`,{method:"POST",headers:{"Content-Type":"application/json","X-Ajan-UI-Token":uiToken},body:JSON.stringify({error:String(error||"Flow üretimi başarısız")})}).catch(()=>{});
}
function flowStatus(detail){if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send("flow-video-status",detail);}
async function flowAuthenticated(contents){
  try{const result=await contents.debugger.sendCommand("Network.getAllCookies");if(result?.cookies?.some(cookie=>cookie.domain.endsWith("labs.google")&&cookie.name==="__Secure-next-auth.session-token"))return true;}catch{}
  try{return await contents.executeJavaScript(`(()=>{const t=(document.body?.innerText||'').toLowerCase();const controls=[...document.querySelectorAll('button,a')];const profile=controls.some(b=>/profil|profile|kullanıcı|user/.test(((b.getAttribute('aria-label')||'')+' '+(b.innerText||'')).toLowerCase()));const project=controls.some(b=>/yeni proje|new project/.test((b.innerText||b.textContent||b.getAttribute('aria-label')||'').toLowerCase()))||!!document.querySelector('a[href*="/project/"]');const signedOut=/oturum aç|sign in|giriş yap/.test(t);return location.hostname==='labs.google'&&!signedOut&&(profile||project||/kredi|credits|pro kullanıcı/.test(t));})()`,true);}catch{return false;}
}
function wait(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
async function waitUntil(check,{timeout=60_000,interval=1000}={}){const end=Date.now()+timeout;let value;while(Date.now()<end){try{value=await check();if(value)return value;}catch{}await wait(interval);}return null;}
async function startFlowChromeHeadless(){
  if(!fs.existsSync(FLOW_CHROME))throw new Error("Google Chrome bulunamadı");fs.mkdirSync(FLOW_CHROME_PROFILE,{recursive:true});
  const child=spawn(FLOW_CHROME,["--headless=new","--remote-debugging-port=0",`--user-data-dir=${FLOW_CHROME_PROFILE}`,"--no-first-run","--no-default-browser-check","--disable-background-timer-throttling",FLOW_URL],{stdio:["ignore","ignore","pipe"]});
  const browserWs=await new Promise((resolve,reject)=>{let buffer="";const timer=setTimeout(()=>reject(new Error("Arka plan Chrome başlatılamadı")),20_000);child.stderr.on("data",data=>{buffer+=data.toString();const match=buffer.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1]);}});child.once("exit",code=>{clearTimeout(timer);reject(new Error(`Arka plan Chrome kapandı (${code})`));});});
  const port=new URL(browserWs).port;const targets=await waitUntil(async()=>{const response=await net.fetch(`http://127.0.0.1:${port}/json/list`);const list=await response.json();return list.find(item=>item.type==="page"&&/labs\.google/.test(item.url))||list.find(item=>item.type==="page");},{timeout:15_000,interval:400});
  if(!targets?.webSocketDebuggerUrl){child.kill();throw new Error("Flow Chrome sekmesine bağlanılamadı");}
  const socket=new WebSocket(targets.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener("open",resolve,{once:true});socket.addEventListener("error",reject,{once:true});});
  let seq=0;const pending=new Map();socket.addEventListener("message",event=>{const msg=JSON.parse(String(event.data));if(msg.id&&pending.has(msg.id)){const p=pending.get(msg.id);pending.delete(msg.id);msg.error?p.reject(new Error(msg.error.message)):p.resolve(msg.result);}});
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));setTimeout(()=>{if(pending.delete(id))reject(new Error(`${method} zaman aşımına uğradı`));},30_000);});
  const executeJavaScript=async(expression)=>{const result=await send("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.text||"Flow betiği başarısız");return result.result?.value;};
  const contents={__chrome:true,executeJavaScript,debugger:{isAttached:()=>true,attach:()=>{},detach:()=>{},sendCommand:send}};
  const close=async()=>{try{socket.close();}catch{}if(child.exitCode!==null)return;await new Promise(resolve=>{const timer=setTimeout(()=>{try{child.kill("SIGKILL");}catch{}resolve();},5000);child.once("exit",()=>{clearTimeout(timer);resolve();});try{child.kill("SIGTERM");}catch{clearTimeout(timer);resolve();}});};
  return{child,contents,send,close};
}
async function checkFlowAccount(){
  if(flowAccountCheckPromise)return flowAccountCheckPromise;
  flowAccountCheckPromise=(async()=>{let probe;try{probe=await startFlowChromeHeadless();await wait(1200);return await flowAuthenticated(probe.contents);}finally{await probe?.close?.();}})();
  try{return await flowAccountCheckPromise;}finally{flowAccountCheckPromise=null;}
}
function flowSessionCookieExists(){
  const cookieDb=path.join(FLOW_CHROME_PROFILE,"Default","Cookies");
  if(!fs.existsSync(cookieDb))return false;
  let db;try{db=new DatabaseSync(cookieDb,{readOnly:true});const chromeNow=(Date.now()+11644473600000)*1000;return Boolean(db.prepare("SELECT 1 FROM cookies WHERE host_key IN ('labs.google', '.labs.google') AND name = '__Secure-next-auth.session-token' AND (expires_utc = 0 OR expires_utc > ?) LIMIT 1").get(chromeNow));}catch{return false;}finally{try{db?.close();}catch{}}
}
ipcMain.handle("flow-account-status",async()=>{
  return{connected:flowSessionCookieExists()};
});
ipcMain.handle("flow-account-connect",async(_event,verify=false)=>{
  if(!fs.existsSync(FLOW_CHROME))return{error:"Google Chrome bulunamadı"};fs.mkdirSync(FLOW_CHROME_PROFILE,{recursive:true});
  if(verify){if(flowLoginWindow&&!flowLoginWindow.killed){const child=flowLoginWindow;child.kill("SIGTERM");await new Promise(resolve=>{const timer=setTimeout(resolve,5000);child.once("exit",()=>{clearTimeout(timer);resolve();});});flowLoginWindow=null;}await wait(800);if(flowSessionCookieExists()){flowStatus({type:"account",connected:true});return{connected:true};}return{error:"Flow oturumu doğrulanamadı. Chrome’da Flow ana sayfasının tamamen açıldığından emin olun."};}
  flowLoginWindow=spawn(FLOW_CHROME,[`--user-data-dir=${FLOW_CHROME_PROFILE}`,"--no-first-run","--no-default-browser-check","--disable-background-mode","--new-window",FLOW_URL],{detached:false,stdio:"ignore"});
  flowLoginWindow.once("exit",()=>{flowLoginWindow=null;setTimeout(()=>flowStatus({type:"account-check"}),800);});
  return{opened:true};
});
async function flowDomAction(contents,source){return contents.executeJavaScript(source,true);}
async function flowTrustedClick(contents,source){
  const point=await flowDomAction(contents,source);if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y))return false;
  await contents.debugger.sendCommand("Input.dispatchMouseEvent",{type:"mousePressed",x:point.x,y:point.y,button:"left",clickCount:1});
  await contents.debugger.sendCommand("Input.dispatchMouseEvent",{type:"mouseReleased",x:point.x,y:point.y,button:"left",clickCount:1});return true;
}
async function setFlowReferenceFiles(contents,files){
  const usable=(files||[]).filter(file=>typeof file==="string"&&fs.existsSync(file));if(!usable.length)return;
  const dbg=contents.debugger;try{if(!dbg.isAttached())dbg.attach("1.3");const {root}=await dbg.sendCommand("DOM.getDocument",{depth:-1,pierce:true});const {nodeIds}=await dbg.sendCommand("DOM.querySelectorAll",{nodeId:root.nodeId,selector:'input[type="file"]'});if(nodeIds[0])await dbg.sendCommand("DOM.setFileInputFiles",{nodeId:nodeIds[0],files:usable});}finally{try{if(dbg.isAttached())dbg.detach();}catch{}}
}
async function automateFlowVideo(detail){
  const runId=String(detail.runId||"");if(!runId)throw new Error("Flow koşusu eksik");
  if(flowWorkerBusy)throw new Error("Flow şu anda başka bir video üretiyor");flowWorkerBusy=true;activeFlowVideoRunId=runId;
  flowStatus({type:"phase",runId,phase:"opening",text:"Flow arka planda hazırlanıyor"});
  const chrome=await startFlowChromeHeadless();flowWorkerWindow=chrome;
  const contents=chrome.contents;
  try{
    await wait(1800);
    if(!await flowAuthenticated(contents))throw Object.assign(new Error("Önce Google Flow hesabını bağlayın"),{code:"FLOW_LOGIN"});
    flowStatus({type:"phase",runId,phase:"project",text:"Flow projesi hazırlanıyor"});
    const projectOpened=await flowDomAction(contents,`(()=>{const all=[...document.querySelectorAll('button,a')];const b=all.find(x=>/(^|\\n)(yeni proje|new project)$/i.test((x.innerText||x.textContent||'').trim()));if(b){b.click();return true}return false})()`);
    if(!projectOpened)throw new Error("Flow yeni proje düğmesi bulunamadı");
    await waitUntil(()=>flowDomAction(contents,`location.pathname.includes('/project/')`),{timeout:30_000,interval:500});
    await setFlowReferenceFiles(contents,(detail.attachments||[]).map(a=>a.path));
    const prompt=[String(detail.prompt||""),`Aspect ratio: ${String(detail.aspect||"16:9")}. Duration: ${String(detail.duration||"8")} seconds. Quality: ${String(detail.quality||"standard")}.`].join("\n\n");
    const promptReady=await waitUntil(()=>flowDomAction(contents,`(()=>{const e=document.querySelector('[data-slate-editor="true"][contenteditable="true"]');if(!e||!e.getClientRects().length)return false;e.focus();return true})()`),{timeout:25_000,interval:800});
    if(!promptReady)throw new Error("Flow prompt alanı bulunamadı; Google arayüzü değişmiş olabilir");
    await contents.debugger.sendCommand("Input.insertText",{text:prompt});
    const filled=await waitUntil(()=>flowDomAction(contents,`(()=>{const e=document.querySelector('[data-slate-editor="true"][contenteditable="true"]');const ready=[...document.querySelectorAll('button')].some(b=>b.getAttribute('aria-disabled')!=='true'&&!b.hasAttribute('aria-haspopup')&&/(^|\\n)(oluştur|üret|generate|create)$/i.test((b.innerText||b.textContent||'').trim()));return Boolean(e?.innerText?.trim())&&ready})()`),{timeout:10_000,interval:500});
    if(!filled)throw new Error("Flow promptu kabul etmedi veya üretim düğmesini etkinleştirmedi");
    flowStatus({type:"phase",runId,phase:"starting",text:"Video üretimi başlatılıyor"});
    const started=await flowTrustedClick(contents,`(()=>{const all=[...document.querySelectorAll('button,[role="button"]')].filter(e=>!e.disabled&&e.getAttribute('aria-disabled')!=='true'&&!e.hasAttribute('aria-haspopup')&&e.getBoundingClientRect().width>0);const b=all.find(e=>/(^|\\n)(oluştur|üret|generate|create)$/i.test((e.innerText||e.textContent||e.getAttribute('aria-label')||'').trim()));if(!b)return null;const r=b.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    if(!started)throw new Error("Flow üretim düğmesi bulunamadı; Google arayüzü değişmiş olabilir");
    flowStatus({type:"phase",runId,phase:"generating",text:"Flow videoyu arka planda üretiyor"});
    const media=await waitUntil(()=>flowDomAction(contents,`(async()=>{const v=[...document.querySelectorAll('video')].filter(v=>v.src).pop();if(!v)return null;try{const r=await fetch(v.src,{credentials:'include'});const type=(r.headers.get('content-type')||'').toLowerCase();if(!r.ok||!type.startsWith('video/'))return null;return{src:r.url,type}}catch{return null}})()`),{timeout:12*60_000,interval:5000});
    if(!media)throw new Error("Flow video üretimini zamanında tamamlamadı");
    const response=await net.fetch(media.src);if(!response.ok)throw new Error(`Flow videosu indirilemedi (${response.status})`);const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length<1024||!String(response.headers.get('content-type')||media.type).toLowerCase().startsWith('video/'))throw new Error("Flow geçerli bir video dosyası döndürmedi");
    const downloadDir=path.join(os.tmpdir(),`ajan-flow-${runId}-${Date.now()}`);fs.mkdirSync(downloadDir,{recursive:true});const file=path.join(downloadDir,"flow-video.mp4");fs.writeFileSync(file,bytes);await importFlowVideo(runId,file);flowStatus({type:"done",runId,text:"Video stüdyoya eklendi"});return{ok:true};
  }catch(error){await reportFlowFailure(runId,error.message);flowStatus({type:"error",runId,error:error.message,needsLogin:error.code==="FLOW_LOGIN"});throw error;}
  finally{activeFlowVideoRunId=null;flowWorkerBusy=false;await flowWorkerWindow?.close?.();flowWorkerWindow=null;}
}
ipcMain.handle("flow-video-run",async(event,detail)=>{
  if(!mainWindow||event.sender!==mainWindow.webContents)return{error:"Yetkisiz istek"};
  if(flowWorkerBusy)return{error:"Flow şu anda başka bir video üretiyor"};
  automateFlowVideo(detail).catch(()=>{});return{started:true};
});
ipcMain.handle("flow-video-select",async(event,runId)=>{
  if(!mainWindow||event.sender!==mainWindow.webContents)return{error:"Yetkisiz istek"};
  const picked=await dialog.showOpenDialog(mainWindow,{title:"Flow videosunu seç",properties:["openFile"],filters:[{name:"Video",extensions:["mp4","mov","webm","m4v"]}]});
  if(picked.canceled||!picked.filePaths[0])return{canceled:true};
  try{return await importFlowVideo(String(runId),picked.filePaths[0]);}catch(error){return{error:error.message};}
});
function versionParts(value){return String(value||"0").replace(/^v/i,"").split(/[.-]/).slice(0,3).map(x=>Number(x)||0);}
function newerVersion(latest,current){const a=versionParts(latest),b=versionParts(current);for(let i=0;i<3;i++){if(a[i]>b[i])return true;if(a[i]<b[i])return false;}return false;}
async function latestRelease(){const response=await net.fetch("https://api.github.com/repos/can379/ajan-konseyi/releases/latest",{headers:{Accept:"application/vnd.github+json","User-Agent":"Ajan-Konseyi-Updater"}});if(response.status===404)return null;if(!response.ok)throw new Error(`GitHub sürüm bilgisi alınamadı (${response.status})`);return response.json();}
function cleanupUpdateCache(keep=""){
  const updates=path.join(app.getPath("userData"),"updates");
  if(!fs.existsSync(updates))return;
  for(const entry of fs.readdirSync(updates,{withFileTypes:true})){
    if(entry.name===keep)continue;
    fs.rmSync(path.join(updates,entry.name),{recursive:true,force:true});
  }
}
ipcMain.handle("app-update-status",async(event)=>{if(!mainWindow||event.sender!==mainWindow.webContents)return{error:"Yetkisiz istek"};try{const release=await latestRelease(),current=app.getVersion();if(!release)return{current,available:false,message:"Henüz yayınlanmış GitHub sürümü yok"};const asset=(release.assets||[]).find(x=>/macos.*arm64.*\.zip$/i.test(x.name))||(release.assets||[]).find(x=>/\.zip$/i.test(x.name));return{current,latest:String(release.tag_name||release.name||""),available:newerVersion(release.tag_name,current),notes:String(release.body||"").slice(0,5000),publishedAt:release.published_at,asset:asset?{name:asset.name,size:asset.size,url:asset.browser_download_url}:null,page:release.html_url};}catch(error){return{error:error.message,current:app.getVersion()};}});
ipcMain.handle("app-update-download",async(event)=>{if(!mainWindow||event.sender!==mainWindow.webContents)return{error:"Yetkisiz istek"};try{const release=await latestRelease();if(!release)throw new Error("İndirilebilir GitHub sürümü yok");const asset=(release.assets||[]).find(x=>/macos.*arm64.*\.zip$/i.test(x.name))||(release.assets||[]).find(x=>/\.zip$/i.test(x.name));if(!asset)throw new Error("Bu Mac için ZIP paketi bulunamadı");const versionDir=String(release.tag_name||"latest").replace(/[^\w.-]/g,"_");cleanupUpdateCache(versionDir);const response=await net.fetch(asset.browser_download_url);if(!response.ok)throw new Error(`Güncelleme indirilemedi (${response.status})`);const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length<1024||Number(asset.size||0)&&bytes.length!==Number(asset.size))throw new Error("İndirilen güncelleme paketi eksik");const dir=path.join(app.getPath("userData"),"updates",versionDir);fs.mkdirSync(dir,{recursive:true});for(const entry of fs.readdirSync(dir))fs.rmSync(path.join(dir,entry),{recursive:true,force:true});const file=path.join(dir,path.basename(asset.name));fs.writeFileSync(file,bytes);const digest=crypto.createHash("sha256").update(bytes).digest("hex");fs.writeFileSync(file+".sha256",`${digest}  ${path.basename(file)}\n`);shell.showItemInFolder(file);return{ok:true,file,sha256:digest,size:bytes.length};}catch(error){return{error:error.message};}});
ipcMain.handle("external-app-choose",async(event)=>{if(!mainWindow||event.sender!==mainWindow.webContents)return{error:"Yetkisiz istek"};const result=await dialog.showOpenDialog(mainWindow,{title:"Uygulama seç",defaultPath:"/Applications",properties:["openFile"],filters:[{name:"macOS uygulaması",extensions:["app"]}]});if(result.canceled||!result.filePaths[0])return{canceled:true};const appPath=result.filePaths[0];if(!appPath.endsWith(".app")||!fs.existsSync(appPath))return{error:"Geçerli bir macOS uygulaması seçin"};return{path:appPath,name:path.basename(appPath,".app")};});
ipcMain.handle("project-open-with",async(event,detail={})=>{if(!mainWindow||event.sender!==mainWindow.webContents)return{error:"Yetkisiz istek"};try{const projectPath=fs.realpathSync(String(detail.projectPath||""));if(!fs.statSync(projectPath).isDirectory())throw new Error("Proje klasörü bulunamadı");const apps={vscode:"Visual Studio Code",terminal:"Terminal","android-studio":"Android Studio"};if(detail.kind==="finder"){const error=await shell.openPath(projectPath);if(error)throw new Error(error);return{ok:true};}let appName=apps[detail.kind];if(detail.kind==="custom"){const custom=fs.realpathSync(String(detail.appPath||""));if(!custom.endsWith(".app")||!fs.existsSync(custom))throw new Error("Uygulama bulunamadı");appName=custom;}if(!appName)throw new Error("Desteklenmeyen uygulama");const child=spawn("open",["-a",appName,projectPath],{stdio:"ignore"});child.unref();return{ok:true};}catch(error){return{error:error.message};}});
async function pollBrowserCommands(){releaseBrowserOriginLockIfExpired();if(browserPollInFlight)return;browserPollInFlight=true;let command;try{const response=await net.fetch("http://127.0.0.1:4780/api/browser/bridge/command",{headers:bridgeHeaders});if(!response.ok)return;({command}=await response.json());if(!command)return;if(command.expiresAt<=Date.now())throw new Error("Tarayıcı izni sona erdi");let result;if(command.action==="open"){expectedBrowserOrigin=command.origin;expectedBrowserOriginUntil=command.expiresAt;await createWindow();if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus();app.focus({steal:true});mainWindow.webContents.send("browser-open",{requestId:command.id,url:command.payload.url,origin:command.origin,actor:command.actor,provider:command.provider,expiresAt:command.expiresAt});await waitForBrowserReady(command.id);const guest=await waitForBrowserGuest();await guest.loadURL(command.payload.url);result={ok:true,url:guest.getURL()};}else{const guest=await waitForBrowserGuest();const activeOrigin=new URL(guest.getURL()).origin;if(command.origin){expectedBrowserOrigin=command.origin;expectedBrowserOriginUntil=command.expiresAt;if(activeOrigin!==command.origin)throw new Error("Aktif sekmenin origin'i değişti");}if(command.action==="snapshot")result=await guest.executeJavaScript(snapshotScript.replace("__ORIGIN__",JSON.stringify(command.origin||activeOrigin)),true);else if(command.action==="navigate"){await guest.loadURL(command.payload.url);result={ok:true,url:guest.getURL()};}else if(command.action==="click"||command.action==="type")result=await guest.executeJavaScript(elementActionScript(command),true);else throw new Error("Desteklenmeyen tarayıcı komutu");}if(command.origin&&new URL(result.url).origin!==command.origin)throw new Error("Origin işlem sırasında değişti");await sendBridgeResult({id:command.id,result});}catch(error){if(command?.id)await sendBridgeResult({id:command.id,error:error.message}).catch(()=>{});}finally{expectedBrowserOrigin=null;expectedBrowserOriginUntil=0;browserPollInFlight=false;}}

function serverReady() {
  return new Promise((resolve) => {
    const req = http.get("http://127.0.0.1:4780/api/state", (res) => { res.resume(); resolve(true); });
    req.setTimeout(500, () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  });
}

async function ensureServer() {
  if (await serverReady()) return;
  const home = app.getPath("home");
  const cliPath = [
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
    path.join(home, ".local", "bin"), path.join(home, ".npm-global", "bin"),
  ].join(path.delimiter);
  serverLog ||= openServerLog(path.join(app.getPath("userData"), "logs"));
  serverLog.line(`sunucu başlatılıyor (deneme ${respawnAttempts + 1})`);
  serverProcess = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: app.getPath("userData"), stdio: ["ignore", "pipe", "pipe"], env: {
      ...process.env,
      PATH: `${cliPath}${path.delimiter}${process.env.PATH || ""}`,
      ELECTRON_RUN_AS_NODE: "1",
      AJAN_KONSEYI_DATA_DIR: app.getPath("userData"),
      AJAN_KONSEYI_SOURCE_DIR: sourceRoot,
      AJAN_UI_TOKEN: uiToken,
      AJAN_BROWSER_BRIDGE_TOKEN: bridgeToken,
    },
  });
  serverProcess.stdout.on("data", (d) => serverLog?.stream.write(d));
  serverProcess.stderr.on("data", (d) => serverLog?.stream.write(d));
  // Bekci: sunucu olurse sebep gunlukte kalir ve artan gecikmeyle yeniden
  // dogar. Eskiden olum fark edilmiyor, arayuz sayaclari bosa akiyordu.
  const child = serverProcess;
  child.on("exit", (code, signal) => {
    if (serverProcess === child) serverProcess = null;
    serverLog?.line(`sunucu öldü (exit=${code} sinyal=${signal || "-"})`);
    if (quittingApp) return;
    respawnAttempts += 1;
    const delay = nextRespawnDelay(respawnAttempts);
    serverLog?.line(`${delay} ms sonra yeniden başlatılacak`);
    clearTimeout(respawnTimer);
    respawnTimer = setTimeout(() => { ensureServer().catch((e) => serverLog?.line(`yeniden başlatma başarısız: ${e.message}`)); }, delay);
  });
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await serverReady()) { respawnAttempts = 0; serverLog.line("sunucu hazır"); return; }
  }
  throw new Error("Yerel sunucu başlatılamadı");
}

// Ikinci savunma hatti: cocuk tutamacimiz olmayan bir sunucu da olebilir
// (uygulama var olan bir sunucuya baglanmis olabilir). Periyodik saglik
// yoklamasi olumu 30 saniye icinde yakalar ve yenisini dogurtur.
setInterval(async () => {
  if (quittingApp || serverProcess) return;
  if (!(await serverReady())) {
    serverLog?.line("sağlık yoklaması başarısız: sunucu yok, yeniden başlatılıyor");
    ensureServer().catch((e) => serverLog?.line(`sağlık yoklaması yeniden başlatma başarısız: ${e.message}`));
  }
}, 30_000);

async function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  await ensureServer();
  mainWindow = new BrowserWindow({
    width: 1500, height: 960, minWidth: 980, minHeight: 680,
    title: "Ajan Konseyi", titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 18 }, backgroundColor: "#111210",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      webviewTag: true, contextIsolation: true, nodeIntegration: false,
    },
  });
  mainWindow.loadURL("http://127.0.0.1:4780");
  // Köprü heartbeat'i webview'e bağlı olamaz: ilk `open` komutu bizzat paneli
  // açıp webview'i hazırlamak zorundadır. Ana arayüz yüklenir yüklenmez dinle.
  mainWindow.webContents.once("did-finish-load",ensureBrowserPoll);
  mainWindow.webContents.on("did-attach-webview",(_event,guest)=>{browserGuests.set(guest.id,guest);browserGuest=guest;guest.setWindowOpenHandler(({url})=>{if(allowedBrowserUrl(url))mainWindow.webContents.send("browser-new-tab",{url,openerId:guest.id});return{action:"deny"};});guest.on("will-navigate",(event,url)=>{if(!browserNavigationAllowed(url))event.preventDefault();});guest.on("will-redirect",(event,url)=>{if(!browserNavigationAllowed(url))event.preventDefault();});guest.session.setPermissionRequestHandler((_contents,permission,callback)=>callback(["clipboard-sanitized-write","fullscreen"].includes(permission)));if(!downloadSessions.has(guest.session)){downloadSessions.add(guest.session);guest.session.on("will-download",(_downloadEvent,item)=>{const runId=activeFlowVideoRunId;if(!runId)return;item.once("done",async(_event,state)=>{if(state!=="completed")return;try{await importFlowVideo(runId,item.getSavePath());activeFlowVideoRunId=null;}catch(error){mainWindow?.webContents.send("flow-video-import-error",{runId,error:error.message});}});});}guest.once("destroyed",()=>{browserGuests.delete(guest.id);if(browserGuest===guest)browserGuest=[...browserGuests.values()].find((item)=>!item.isDestroyed())||null;});ensureBrowserPoll();});
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("context-menu", (_event, params) => {
    const selected=String(params.selectionText||"").trim();
    if(selected){
      const query=selected.slice(0,500);
      Menu.buildFromTemplate([
        {label:`“${query.slice(0,42)}${query.length>42?"…":""}” metnini araştır`,click:()=>shell.openExternal(`https://www.google.com/search?q=${encodeURIComponent(query)}`)},
        {label:"Google ile ara",click:()=>shell.openExternal(`https://www.google.com/search?q=${encodeURIComponent(query)}`)},
        {type:"separator"},
        {label:"Kopyala",role:"copy"},
      ]).popup({window:mainWindow});
      return;
    }
    if(params.isEditable){Menu.buildFromTemplate([{role:"cut",label:"Kes"},{role:"copy",label:"Kopyala"},{role:"paste",label:"Yapıştır"},{type:"separator"},{role:"selectAll",label:"Tümünü seç"}]).popup({window:mainWindow});return;}
    if (params.mediaType !== "image" || !params.srcURL) return;
    const src = params.srcURL;
    const imageBytes = async () => Buffer.from(await (await net.fetch(src)).arrayBuffer());
    const items = [];
    if (/^https?:\/\/(127\.0\.0\.1|localhost):4780\/uploads\//i.test(src)) items.push({
      label:"Finder’da Göster", click:async()=>{ try { await net.fetch("http://127.0.0.1:4780/api/media/reveal",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({url:src})}); } catch {} },
    });
    items.push({ label:"Görseli Kopyala", click:async()=>{ try { clipboard.writeImage(nativeImage.createFromBuffer(await imageBytes())); } catch {} } });
    items.push({ label:"Görseli Farklı Kaydet…", click:async()=>{ try { const guessed=decodeURIComponent(new URL(src).pathname.split("/").pop()||"gorsel.png"); const result=await dialog.showSaveDialog(mainWindow,{defaultPath:guessed}); if(!result.canceled&&result.filePath) require("node:fs").writeFileSync(result.filePath,await imageBytes()); } catch {} } });
    Menu.buildFromTemplate(items).popup({window:mainWindow});
  });
  mainWindow.on("closed",()=>{mainWindow=null;browserGuest=null;browserGuests.clear();if(browserPoll)clearInterval(browserPoll);browserPoll=null;});
}

app.whenReady().then(async () => {
  if (process.platform === "darwin") {
    app.dock.setIcon(path.join(root, "assets", "ajan-konseyi-icon-v2.png"));
  }
  await createWindow();
  app.on("activate", createWindow);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    quittingApp = true; clearTimeout(respawnTimer);
    if (serverProcess) serverProcess.kill("SIGTERM");
    app.quit();
  }
});

app.on("before-quit", () => { quittingApp = true; clearTimeout(respawnTimer); if (serverProcess) serverProcess.kill("SIGTERM"); });
