// Gercek Electron penceresinde GERCEK fare olaylariyla (webContents.sendInputEvent
// renderer'a isTrusted=true olay uretir) proje sohbeti satirini test eder.
// Sonuc JSON olarak stdout'a "E2E_RESULT:" onekiyle yazilir.
const { app, BrowserWindow } = require("electron");
const URL_TO_TEST = process.env.E2E_URL || "http://127.0.0.1:4780";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(win) {
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  const moveTo = async (x, y) => {
    // Gercek fare hareketi: iki adimda gonderilir ki tarayici hover
    // durumunu ve mouseover/mouseout zincirini normal sekilde uretsin.
    wc.sendInputEvent({ type: "mouseMove", x: Math.round(x), y: Math.round(y) });
    await sleep(60);
    wc.sendInputEvent({ type: "mouseMove", x: Math.round(x), y: Math.round(y) });
    await sleep(180);
  };
  // Menu acilana kadar fareyi yeniden oynat: pencere odagi/ilk kare gecikmesi
  // gibi zamanlama kaynakli kirilganligi giderir, kontrolu zayiflatmaz.
  const moveUntilMenu = async (x, y, selector) => {
    for (let i = 0; i < 4; i++) {
      await moveTo(x + (i % 2), y);
      const open = await js(`!document.querySelector('${selector}').hidden`);
      if (open) return true;
      await sleep(250);
    }
    return false;
  };
  const clickAt = async (x, y) => {
    await moveTo(x, y);
    wc.sendInputEvent({ type: "mouseDown", x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 });
    await sleep(40);
    wc.sendInputEvent({ type: "mouseUp", x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 });
    await sleep(400);
  };

  const results = {};
  // Kenar cubugu acik olsun (masaustu genisligi)
  await js(`(()=>{const s=document.getElementById('sidebar');s.classList.remove('hidden');return true})()`);
  await sleep(400);

  const target = await js(`(()=>{
    const rows=[...document.querySelectorAll('#project-list .project-runs .run-item[data-run]')];
    if(!rows.length) return null;
    const row=rows[0], b=row.getBoundingClientRect();
    const proj=row.closest('.project-group').querySelector('.project-item[data-proj]');
    const pb=proj.getBoundingClientRect();
    return {run:row.dataset.run, x:Math.round(b.x+40), y:Math.round(b.y+b.height/2),
            rowRight:Math.round(b.right), rowWidth:Math.round(b.width),
            projX:Math.round(pb.x+40), projY:Math.round(pb.y+pb.height/2),
            sidebarRight:Math.round(document.getElementById('sidebar').getBoundingClientRect().right)};
  })()`);
  if (!target) return { skipped: "proje sohbeti bulunamadi" };
  results.hedef = target;

  // 1) Satir kapsayicidan tasmiyor mu
  results.satirTasmiyor = target.rowRight <= target.sidebarRight + 1;

  // 2) HOVER: sohbet satiri -> yalniz sohbet menusu acilmali
  await moveUntilMenu(target.x, target.y, '#run-context-menu');
  results.hover = await js(`(()=>{
    const rm=document.getElementById('run-context-menu'), pm=document.getElementById('project-context-menu');
    const b=rm.getBoundingClientRect(), sb=document.getElementById('sidebar').getBoundingClientRect();
    return {sohbetMenusuAcik:!rm.hidden, sohbetMenuId:rm.dataset.runId||'',
            projeMenusuKapali:pm.hidden,
            menuX:Math.round(b.x), menuY:Math.round(b.y), menuW:Math.round(b.width), menuH:Math.round(b.height),
            sidebarRight:Math.round(sb.right),
            ekranIcinde:b.x>=0&&b.y>=0&&b.right<=window.innerWidth&&b.bottom<=window.innerHeight,
            satirinHemenSaginda:(()=>{const row=document.querySelector('#project-list .project-runs .run-item[data-run]').getBoundingClientRect();
              return Math.round(b.x)>=Math.round(row.right)&&Math.round(b.x)<=Math.round(row.right)+14;})(),
            menuUstte:(()=>{const el=document.elementFromPoint(Math.round(b.x+6),Math.round(b.y+10));
              return !!el&&!!el.closest('#run-context-menu');})(),
            sidebarAcik:!document.getElementById('sidebar').classList.contains('hidden')};
  })()`);

  // 3) Satirdan menuye fare gecisi -> menu kapanmamali
  const mid = await js(`(()=>{const b=document.getElementById('run-context-menu').getBoundingClientRect();
    return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+18)};})()`);
  await moveTo(mid.x, mid.y);
  results.menuyeGecince = await js(`(()=>{const rm=document.getElementById('run-context-menu');
    return {acikKaldi:!rm.hidden, id:rm.dataset.runId||''};})()`);

  // 4) Yeniden render sonrasi davranis bozulmamali + coklu dinleyici olmamali
  await js(`renderProjects(); renderConversations();`);
  await sleep(500);
  await moveUntilMenu(target.x, target.y, '#run-context-menu');
  results.renderSonrasi = await js(`(()=>{
    const rm=document.getElementById('run-context-menu'), pm=document.getElementById('project-context-menu');
    return {sohbetMenusuAcik:!rm.hidden, projeMenusuKapali:pm.hidden, id:rm.dataset.runId||''};
  })()`);

  // 5) Proje basligina hover -> proje menusu acilir, sohbet menusu kapanir
  await moveUntilMenu(target.projX, target.projY, '#project-context-menu');
  results.projeBasligi = await js(`(()=>{
    const rm=document.getElementById('run-context-menu'), pm=document.getElementById('project-context-menu');
    return {projeMenusuAcik:!pm.hidden, sohbetMenusuKapandi:rm.hidden, ikisiBirdenAcikDegil:!(!rm.hidden&&!pm.hidden)};
  })()`);

  // 6) Sohbet satirina donunce proje menusu kapanmali (sohbet oncelikli)
  await moveUntilMenu(target.x, target.y, '#run-context-menu');
  results.sohbeteDonus = await js(`(()=>{
    const rm=document.getElementById('run-context-menu'), pm=document.getElementById('project-context-menu');
    return {sohbetMenusuAcik:!rm.hidden, projeMenusuKapali:pm.hidden};
  })()`);

  // 7) Fare tamamen uzaklasinca menu kapanmali
  await moveTo(900, 500);
  await sleep(600);
  results.uzaklasinca = await js(`(()=>{const rm=document.getElementById('run-context-menu');return {kapandi:rm.hidden};})()`);

  // 8) TIKLAMA: sohbet acilmali, sol panel acik kalmali.
  // Once cok sayida render yapip tiklama sayacini kurariz: dinleyici
  // coklanmissa tek tiklama openSidebarRun'i birden fazla kez cagirir.
  await js(`(()=>{for(let i=0;i<6;i++){renderProjects();renderConversations();}
    window.__openCalls=0; const orig=window.openSidebarRun||openSidebarRun;
    window.openSidebarRun=function(...a){window.__openCalls++;return orig.apply(this,a);};
    return true})()`);
  await sleep(400);
  await js(`window.__selBefore = selectedRun;`);
  await clickAt(target.x, target.y);
  results.tiklama = await js(`(()=>({
    oncekiSecim:window.__selBefore||null,
    yeniSecim:selectedRun,
    sohbetAcildi:selectedRun===${JSON.stringify(target.run)},
    domSecili:document.querySelector('#project-list .run-item.selected')?.dataset.run||'',
    sidebarAcikKaldi:!document.getElementById('sidebar').classList.contains('hidden'),
    gorunum:activeMainView,
    tiklamaSayaci:window.__openCalls,
    tekDinleyici:window.__openCalls===1
  }))()`);

  return results;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: true, webPreferences: { sandbox: false } });
  let out;
  try {
    await win.loadURL(URL_TO_TEST);
    await sleep(2500);
    out = await run(win);
  } catch (error) {
    out = { error: String(error && error.message || error) };
  }
  console.log("E2E_RESULT:" + JSON.stringify(out));
  win.destroy();
  app.exit(0);
});
