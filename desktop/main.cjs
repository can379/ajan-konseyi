const { app, BrowserWindow, shell, Menu, dialog, clipboard, nativeImage, net, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { SENSITIVE_FIELD_SNIPPET } = require("../src/browserFieldPolicy.cjs");

const root = path.resolve(__dirname, "..");
let serverProcess = null;
let mainWindow = null;
let browserGuest = null;
let browserPoll = null;
// Açılışı bekleyen komutun beklenen origin'i. Yönlendirme COMMIT EDİLMEDEN
// karşılaştırılır; yükleme sonrası kontrol geç kalıyordu (çerez/istek gitmiş olur).
let expectedBrowserOrigin = null;
const browserReadyWaiters = new Map();
const uiToken = crypto.randomBytes(32).toString("base64url");
const bridgeToken = crypto.randomBytes(32).toString("base64url");
process.env.AJAN_UI_TOKEN = uiToken;
app.setName("Ajan Konseyi");

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
// Gönderen doğrulaması: yalnız ana pencerenin webContents'i bir açılışı çözebilir.
// Bugün webview'a preload verilmediği için (ui/app.js) misafir sayfanın ipcRenderer'a
// erişimi yok; bu kontrol derinlemesine savunmadır — ileride ikinci bir pencere veya
// webview preload'u eklenirse yetkisiz çözümlemeyi engeller.
ipcMain.on("browser-ready",(event,id)=>{
  if(!mainWindow||mainWindow.isDestroyed()||event.sender!==mainWindow.webContents)return;
  browserReadyWaiters.get(String(id))?.();
});
async function pollBrowserCommands(){if(!browserGuest||browserGuest.isDestroyed())return;let command;try{const response=await net.fetch("http://127.0.0.1:4780/api/browser/bridge/command",{headers:bridgeHeaders});if(!response.ok)return;({command}=await response.json());if(!command)return;if(command.expiresAt<=Date.now())throw new Error("Tarayıcı izni sona erdi");let result;if(command.action==="open"){expectedBrowserOrigin=command.origin;await createWindow();if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus();mainWindow.webContents.send("browser-open",{requestId:command.id,url:command.payload.url,origin:command.origin,actor:command.actor,provider:command.provider,expiresAt:command.expiresAt});await waitForBrowserReady(command.id);await browserGuest.loadURL(command.payload.url);result={ok:true,url:browserGuest.getURL()};}else{expectedBrowserOrigin=command.origin;if(new URL(browserGuest.getURL()).origin!==command.origin)throw new Error("Paylaşılan origin değişti");if(command.action==="snapshot")result=await browserGuest.executeJavaScript(snapshotScript.replace("__ORIGIN__",JSON.stringify(command.origin)),true);else if(command.action==="navigate"){await browserGuest.loadURL(command.payload.url);result={ok:true,url:browserGuest.getURL()};}else if(command.action==="click"||command.action==="type")result=await browserGuest.executeJavaScript(elementActionScript(command),true);else throw new Error("Desteklenmeyen tarayıcı komutu");}if(new URL(result.url).origin!==command.origin)throw new Error("Origin işlem sırasında değişti");await sendBridgeResult({id:command.id,result});}catch(error){if(command?.id)await sendBridgeResult({id:command.id,error:error.message}).catch(()=>{});}}

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
  serverProcess = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: app.getPath("userData"), stdio: "ignore", env: {
      ...process.env,
      PATH: `${cliPath}${path.delimiter}${process.env.PATH || ""}`,
      ELECTRON_RUN_AS_NODE: "1",
      AJAN_KONSEYI_DATA_DIR: app.getPath("userData"),
      AJAN_UI_TOKEN: uiToken,
      AJAN_BROWSER_BRIDGE_TOKEN: bridgeToken,
    },
  });
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await serverReady()) return;
  }
  throw new Error("Yerel sunucu başlatılamadı");
}

async function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  await ensureServer();
  mainWindow = new BrowserWindow({
    width: 1500, height: 960, minWidth: 980, minHeight: 680,
    title: "Ajan Konseyi", titleBarStyle: "hiddenInset", backgroundColor: "#111210",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      webviewTag: true, contextIsolation: true, nodeIntegration: false,
    },
  });
  mainWindow.loadURL("http://127.0.0.1:4780");
  mainWindow.webContents.on("did-attach-webview",(_event,guest)=>{browserGuest=guest;guest.setWindowOpenHandler(()=>({action:"deny"}));guest.on("will-navigate",(event,url)=>{if(!browserNavigationAllowed(url))event.preventDefault();});guest.on("will-redirect",(event,url)=>{if(!browserNavigationAllowed(url))event.preventDefault();});guest.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));guest.session.on("will-download",(event)=>event.preventDefault());guest.once("destroyed",()=>{browserGuest=null;});if(!browserPoll)browserPoll=setInterval(pollBrowserCommands,500);});
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("context-menu", (_event, params) => {
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
  mainWindow.on("closed",()=>{mainWindow=null;browserGuest=null;if(browserPoll)clearInterval(browserPoll);browserPoll=null;});
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
    if (serverProcess) serverProcess.kill("SIGTERM");
    app.quit();
  }
});

app.on("before-quit", () => { if (serverProcess) serverProcess.kill("SIGTERM"); });
