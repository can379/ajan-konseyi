const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("desktopAPI", Object.freeze({
  isDesktop:true,
  uiToken:process.env.AJAN_UI_TOKEN || "",
  onBrowserOpen(callback) { const handler=(_event,detail)=>callback(detail); ipcRenderer.on("browser-open",handler); return ()=>ipcRenderer.removeListener("browser-open",handler); },
  onBrowserNewTab(callback) { const handler=(_event,detail)=>callback(detail); ipcRenderer.on("browser-new-tab",handler); return ()=>ipcRenderer.removeListener("browser-new-tab",handler); },
  setActiveBrowserGuest(webContentsId) { ipcRenderer.send("browser-active-guest",Number(webContentsId)||0); },
  browserReady(requestId) { ipcRenderer.send("browser-ready",String(requestId||"")); },
  beginFlowVideo(runId,prompt) { ipcRenderer.send("flow-video-begin",{runId:String(runId||""),prompt:String(prompt||"")}); },
  selectFlowVideo(runId) { return ipcRenderer.invoke("flow-video-select",String(runId||"")); },
  flowAccountStatus() { return ipcRenderer.invoke("flow-account-status"); },
  connectFlowAccount(verify = false) { return ipcRenderer.invoke("flow-account-connect", Boolean(verify)); },
  runFlowVideo(detail) { return ipcRenderer.invoke("flow-video-run",detail); },
  onFlowVideoStatus(callback) { const handler=(_event,detail)=>callback(detail); ipcRenderer.on("flow-video-status",handler); return ()=>ipcRenderer.removeListener("flow-video-status",handler); },
  updateStatus() { return ipcRenderer.invoke("app-update-status"); },
  downloadUpdate() { return ipcRenderer.invoke("app-update-download"); },
}));
