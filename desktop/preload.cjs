const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("desktopAPI", Object.freeze({
  isDesktop:true,
  uiToken:process.env.AJAN_UI_TOKEN || "",
  onBrowserOpen(callback) { const handler=(_event,detail)=>callback(detail); ipcRenderer.on("browser-open",handler); return ()=>ipcRenderer.removeListener("browser-open",handler); },
  browserReady(requestId) { ipcRenderer.send("browser-ready",String(requestId||"")); },
}));
