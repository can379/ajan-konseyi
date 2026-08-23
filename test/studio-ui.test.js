import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("yaratıcı stüdyo stil dosyası sunulur ve güçlendirme aracı özel tasarıma sahiptir",()=>{
  const server=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");
  const html=fs.readFileSync(new URL("../ui/index.html",import.meta.url),"utf8");
  const css=fs.readFileSync(new URL("../ui/studio.css",import.meta.url),"utf8");
  assert.match(server,/studio\.css/); assert.match(html,/studio-enhance-bar/); assert.match(css,/#btn-enhance-prompt/);
  assert.doesNotMatch(html,/id="image-prompt"[^>]+required/);
});

test("stüdyo geçmişi son koşu yerine bütün üretim gruplarını render eder",()=>{
  const app=fs.readFileSync(new URL("../ui/app.js",import.meta.url),"utf8");
  assert.match(app,/batches\.map\(\(batch\)=>/); assert.match(app,/Tüm üretimler/); assert.match(app,/studio-output-group/);
  assert.doesNotMatch(app,/const batch = \(activeStudioRunId/);
});

test("stüdyo panodan görsel yapıştırmayı referans yüklemesine yönlendirir",()=>{
  const app=fs.readFileSync(new URL("../ui/app.js",import.meta.url),"utf8");
  const html=fs.readFileSync(new URL("../ui/index.html",import.meta.url),"utf8");
  assert.match(app,/clipboardData/); assert.match(app,/activeMainView!=="images"/); assert.match(app,/uploadStudioReference\(file\)/);
  assert.match(html,/⌘V/);
});

test("video üretimi API yerine Flow PRO oturumuna ve kalıcı geçmişe bağlanır",()=>{
  const app=fs.readFileSync(new URL("../ui/app.js",import.meta.url),"utf8");
  const server=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");
  const main=fs.readFileSync(new URL("../desktop/main.cjs",import.meta.url),"utf8");
  assert.match(app,/google-flow-subscription/); assert.match(app,/openFlowBrowser/); assert.match(app,/Videoyu seç/);
  assert.match(app,/4 saniye/); assert.match(app,/10 saniye · Omni/);
  assert.match(server,/\/api\/flow-video-runs/); assert.match(server,/Flow videosu stüdyoya aktarıldı/);
  assert.match(main,/will-download/); assert.match(main,/importFlowVideo/); assert.match(main,/flow-video-select/);
});

test("Flow girişi Electron yerine gerçek Chrome kalıcı profiliyle yapılır",()=>{
  const main=fs.readFileSync(new URL("../desktop/main.cjs",import.meta.url),"utf8");
  const preload=fs.readFileSync(new URL("../desktop/preload.cjs",import.meta.url),"utf8");
  assert.match(main,/Google Chrome\.app\/Contents\/MacOS\/Google Chrome/);
  assert.match(main,/flow-chrome-profile/); assert.match(main,/--headless=new/);
  assert.match(main,/fetch\(v\.src,\{credentials:'include'\}\)/); assert.match(main,/net\.fetch\(media\.src\)/); assert.match(main,/fs\.writeFileSync\(file,bytes\)/);
  assert.match(preload,/connectFlowAccount/); assert.match(preload,/runFlowVideo/);
});
