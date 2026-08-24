import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceState } from "../src/workspaceState.js";
import { Config } from "../src/config.js";

test("proje izinleri ve yetenekler uygulama yeniden açıldığında korunur",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"ajan-security-"));
  const first=new WorkspaceState(root);
  first.setPermissions("project-1",{files:"allow",terminal:"deny",browser:"ask"});
  const skill=first.saveSkill({name:"Kalite kontrolü",version:"1.2.0",instructions:"Testleri çalıştır."});
  first.enableSkill(skill.id,"project-1",true);

  const reopened=new WorkspaceState(root);
  assert.deepEqual(reopened.data.permissions["project-1"],{files:"allow",terminal:"deny",browser:"ask"});
  assert.equal(reopened.data.skills[0].name,"Kalite kontrolü");
  assert.deepEqual(reopened.data.skills[0].enabledProjects,["project-1"]);
});

test("masaüstü uygulaması veri yolunu paket adından bağımsız sabitler",()=>{
  const source=fs.readFileSync(path.resolve("desktop/main.cjs"),"utf8");
  const stablePath=source.indexOf('app.setPath("userData", path.join(app.getPath("appData"), "Ajan Konseyi"))');
  const firstUse=source.indexOf('app.getPath("userData")');
  assert.ok(stablePath>=0,"sabit userData yolu tanımlanmalı");
  assert.ok(stablePath<firstUse,"userData ilk kullanımından önce sabitlenmeli");
});

test("bildirim türleri kalıcı ayarlanır ve projeler güvenli harici uygulamalarda açılır",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"ajan-settings-"));
  const config=new Config(root);
  config.update({notifications:true,notificationEvents:{done:false,error:true,approval:false}});
  assert.deepEqual(new Config(root).data.notificationEvents,{done:false,error:true,approval:false});
  const main=fs.readFileSync(path.resolve("desktop/main.cjs"),"utf8");
  const preload=fs.readFileSync(path.resolve("desktop/preload.cjs"),"utf8");
  assert.match(main,/ipcMain\.handle\("project-open-with"/);
  assert.match(main,/fs\.realpathSync\(String\(detail\.projectPath/);
  assert.match(main,/detail\.kind==="custom"/);
  assert.match(preload,/openProjectWith\(detail\)/);
  assert.match(preload,/chooseExternalApp\(\)/);
});

test("yetenek ekleme yerel form kullanır, modal taşmaz ve dar araç sekmeleri erişilebilir kalır",()=>{
  const app=fs.readFileSync(path.resolve("ui/app.js"),"utf8");
  const html=fs.readFileSync(path.resolve("ui/index.html"),"utf8");
  const css=fs.readFileSync(path.resolve("ui/style.css"),"utf8");
  assert.match(app,/id="skill-form"/);
  assert.doesNotMatch(app,/prompt\("Yetenek adı"/);
  assert.match(css,/#main\{flex:1 1 680px;min-width:540px\}/);
  assert.match(css,/#tool-panel\{flex:0 1 clamp\(620px,46vw,820px\)/);
  assert.match(css,/#tool-panel\{container-type:inline-size;container-name:tool-panel\}/);
  assert.match(css,/@container tool-panel \(max-width:720px\)/);
  assert.match(css,/\.tool-tabs button\{[\s\S]*?flex:0 0 38px;[\s\S]*?font-size:0;/);
  assert.match(css,/\.tool-tabs button\.active\{[\s\S]*?flex:1 1 112px;[\s\S]*?font-size:12px;/);
  assert.match(css,/\.skill-modal\{[\s\S]*?box-sizing:border-box;[\s\S]*?max-width:100%;[\s\S]*?overflow-x:hidden;/);
  assert.match(css,/\.skill-modal form\{grid-template-columns:minmax\(0,2fr\) minmax\(0,1fr\)\}/);
  assert.doesNotMatch(html,/id="btn-open-(?:browser|terminal)"/);
  assert.match(html,/id="btn-tools"[^>]+aria-controls="tool-panel"/);
  assert.match(html,/id="tool-menu" class="tool-body"/);
  assert.match(app,/function showToolPicker\(\)/);
  assert.match(css,/#tool-menu\.tool-body\{[\s\S]*?position:static;[\s\S]*?flex:1;/);
  assert.match(html,/class="tool-tabs" hidden/);
  assert.match(html,/id="tool-current-title"/);
  assert.match(html,/id="btn-settings"/);
  assert.doesNotMatch(html,/href="\/api\/bridge\/instructions"/);
  assert.match(html,/id="settings-screen"/);
  assert.match(html,/id="f-notify-done"/);
  assert.match(html,/data-project-app="vscode"/);
  assert.match(html,/id="sidebar-resizer"[^>]+role="separator"/);
  assert.match(html,/id="tool-resizer"[^>]+role="separator"/);
  assert.match(app,/ajan\.sidebar\.width/);
  assert.match(app,/ajan\.tool\.width/);
  assert.match(css,/--sidebar-width:276px;--tool-width:620px/);
  assert.match(css,/@container \(max-width:680px\)/);
  assert.match(css,/#chat,#empty-state,#typing,#live\{width:100%;max-width:none/);
  assert.match(css,/#chat,#typing,#live\{margin-left:0!important;margin-right:auto!important\}/);
  assert.match(css,/#composer\{margin-left:0!important;margin-right:auto!important\}/);
  assert.match(css,/#app:has\(#sidebar\.hidden\) #topbar\{padding-left:96px\}/);
  assert.match(css,/#app:has\(#sidebar\.hidden\):has\(#tool-panel\.closed\) #chat/);
  assert.match(css,/width:min\(100%,760px\);max-width:760px;margin-left:auto!important/);
});

test("üst çubuk ajanları ve hızlı model ayarlarını görünür tutar",()=>{
  const html=fs.readFileSync(path.resolve("ui/index.html"),"utf8");
  const css=fs.readFileSync(path.resolve("ui/style.css"),"utf8");
  const app=fs.readFileSync(path.resolve("ui/app.js"),"utf8");
  assert.match(html,/id="tb-agents" aria-label="Ajanlar ve hızlı model ayarları"/);
  assert.doesNotMatch(css,/#tb-agents[^\n{]*\{display:none!important\}/);
  assert.match(app,/data-agent-pop=/);
  assert.match(app,/memberCardHTML\(mem\)/);
});

test("sohbet işlem menüsü fare satırdan menüye geçerken açık kalır",()=>{
  const app=fs.readFileSync(path.resolve("ui/app.js"),"utf8");
  const css=fs.readFileSync(path.resolve("ui/style.css"),"utf8");
  // Satirdan menuye gecerken menu acik kalir (relatedTarget + gecikmeli kapanma).
  assert.match(app,/const next=event\.relatedTarget/);
  assert.match(app,/function scheduleHideRunMenu\(delay=260\)/);
  assert.match(app,/document\.body\.appendChild\(menu\)/);
  assert.match(app,/const x=opensLeft\?Math\.max\(pad,anchorLeft-width-gap\):anchorRight\+gap/);
  assert.match(app,/openSidebarRun\(row\.dataset\.run\)/);
  assert.match(css,/#run-context-menu:before\{[^}]*left:-10px/);
  assert.match(css,/#run-context-menu\.opens-left:before/);
  assert.match(css,/#run-context-menu\{position:fixed\}/);
});

test("proje altı sohbet proje menüsünü açmaz ve masaüstü panelini kapatmaz",()=>{
  const app=fs.readFileSync(path.resolve("ui/app.js"),"utf8");
  // Sohbet satiri proje satirindan ONCE cozulur; proje menusu asla acilmaz.
  assert.match(app,/const runRow=target\.closest\("\.run-item\[data-run\]"\)/);
  assert.match(app,/if\(runRow\)return\{kind:"run",row:runRow\}/);
  assert.match(app,/hideProjectMenu\(\)/);
  assert.match(app,/!window\.desktopAPI && window\.matchMedia\("\(max-width: 760px\)"\)\.matches/);
  // Yeniden render sonrasi hover tazelenir (dinleyici coklanmadan).
  assert.match(app,/function syncSidebarHover\(\)/);
  assert.match(app,/document\.elementFromPoint\(lastPointer\.x,lastPointer\.y\)/);
  // Tiklama delegasyonla ele alinir ve yayilim durdurulur.
  assert.match(app,/sidebar\.addEventListener\("click",\(event\)=>\{[\s\S]*?openSidebarRun\(row\.dataset\.run\)/);
  assert.doesNotMatch(app,/row\.addEventListener\("mouseenter"/);
});

test("yerel görev bütçesi abonelik kotası sanılmaması için varsayılan olarak kapalıdır",()=>{
  const html=fs.readFileSync(path.resolve("ui/index.html"),"utf8");
  const app=fs.readFileSync(path.resolve("ui/app.js"),"utf8");
  const server=fs.readFileSync(path.resolve("server.js"),"utf8");
  const orchestrator=fs.readFileSync(path.resolve("src/orchestrator.js"),"utf8");
  assert.match(html,/id="f-budget-enabled"/);
  assert.match(app,/enabled:\$\("f-budget-enabled"\)\.checked/);
  assert.match(server,/enabled:body\.budget\?\.enabled===true/);
  assert.match(orchestrator,/if\(budget\.enabled&&!opts\.ignoreBudget/);
});

test("bildirim durumu kalıcıdır; sağlayıcı kullanım ve kota özeti doğrudan yerel kayıtlardan okunur",()=>{
  const html=fs.readFileSync(path.resolve("ui/index.html"),"utf8");
  const app=fs.readFileSync(path.resolve("ui/app.js"),"utf8");
  const css=fs.readFileSync(path.resolve("ui/style.css"),"utf8");
  const server=fs.readFileSync(path.resolve("server.js"),"utf8");
  assert.match(html,/id="quota-overview"/);
  assert.match(app,/ajan\.notifications\.read/);
  assert.match(app,/ajan\.notifications\.dismissed/);
  assert.match(app,/data-notification-delete/);
  assert.match(app,/Math\.abs\(dx\)>70/);
  assert.match(app,/run\.budget\?\.enabled&&run\.budget\?\.stopped/);
  assert.match(app,/function renderQuotaOverview\(\)/);
  assert.match(app,/kesin kalan kotayı yerel oturumunda paylaşmıyor/);
  assert.match(app,/Model-özel kotalar genel kotaya karıştırılmaz/);
  assert.match(html,/<div class="side-foot">[\s\S]*id="quota-overview"[\s\S]*id="btn-settings"/);
  assert.match(server,/providerQuotas:providerQuotas\(\)/);
  assert.match(server,/latestByLimit\.get\("codex"\)/);
  assert.doesNotMatch(server,/com\.steipete\.codexbar/i);
  assert.doesNotMatch(server,/CodexBarCLI/i);
  assert.match(server,/scanCodexAccountUsage/);
  assert.match(server,/scanClaudeAccountUsage/);
  assert.match(server,/plan-usage-history\.json/);
  assert.match(server,/Antigravity Models & Usage yerel sağlayıcı ekranı/);
  assert.match(server,/retrieveUserQuotaSummary|Models & Usage/);
  assert.match(server,/total_token_usage/);
  assert.match(server,/readFileSlice/);
  assert.doesNotMatch(server,/\["cost","--provider"/);
  assert.match(server,/todayCost:today\.cost,month:calendarMonth\.month,monthCost:calendarMonth\.cost/);
  assert.match(server,/thirtyDayCost:totals\.cost/);
  assert.match(app,/Tahmini API karşılığı/);
  assert.match(app,/Bu ay · API eşdeğeri/);
  assert.match(app,/Son 30 gün/);
  assert.match(app,/quota\.accountEmail/);
  assert.match(app,/quota-overview"\)\?\.addEventListener\("mouseleave"/);
  assert.match(css,/\.notification-item\.dismiss-left/);
  assert.match(css,/\.quota-card:hover \.quota-tooltip/);
  assert.match(css,/\.quota-bars/);
  assert.match(css,/inset:auto auto 92px 14px!important/);
  assert.match(fs.readFileSync(path.resolve("desktop/main.cjs"),"utf8"),/Google ile ara/);
});
