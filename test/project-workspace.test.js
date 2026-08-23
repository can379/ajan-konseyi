import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("proje sohbetleri bağlam devralır ve yeni sohbet düğmesi sunar",()=>{
  const orch=fs.readFileSync(new URL("../src/orchestrator.js",import.meta.url),"utf8");
  const app=fs.readFileSync(new URL("../ui/app.js",import.meta.url),"utf8");
  assert.match(orch,/Projede önceki sohbetlerden devralınan bağlam/);
  assert.match(orch,/Kalıcı proje hafızası/);
  assert.match(orch,/\.slice\(0, 6\)/);
  assert.match(app,/data-new-project-chat/);
  assert.match(app,/data-project-terminal/);
  assert.doesNotMatch(app,/project-new-chat/);
  assert.match(app,/bindProjectContextMenu/);
});

test("yerel proje çıktıları güvenli sağ önizleme panelinde açılır",()=>{
  const server=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");
  const app=fs.readFileSync(new URL("../ui/app.js",import.meta.url),"utf8");
  const html=fs.readFileSync(new URL("../ui/index.html",import.meta.url),"utf8");
  assert.match(server,/\/api\/project-file/);
  assert.match(server,/isWithin\(path\.resolve\(project\.path\),requested\)/);
  assert.match(app,/data-artifact-path/);
  assert.match(html,/data-tool-tab="preview"/);
  assert.match(html,/preview-frame[^>]+sandbox="allow-forms allow-modals allow-popups allow-scripts"/);
});
