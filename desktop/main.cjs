const { app, BrowserWindow, shell, Menu, dialog, clipboard, nativeImage, net } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const http = require("node:http");

const root = path.resolve(__dirname, "..");
let serverProcess = null;
let mainWindow = null;
app.setName("Ajan Konseyi");

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
  mainWindow.on("closed", () => { mainWindow = null; });
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
