// Sag arac panelinin GERCEK fare ile yeniden boyutlandirilmasini test eder.
// webContents.sendInputEvent renderer'a isTrusted=true olay uretir; sentetik
// PointerEvent'lerin aksine setPointerCapture da normal calisir.
//
// Iki davranis olculur:
//   1) Surukleme imlece YAPISIK ilerler (panel geriden gelmez).
//   2) Fare BIRAKILDIKTAN sonra hareket paneli artik degistirmez.
const { app, BrowserWindow } = require("electron");
const URL_TO_TEST = process.env.E2E_URL || "http://127.0.0.1:4780";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(win) {
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  const move = async (x, y) => {
    wc.sendInputEvent({ type: "mouseMove", x: Math.round(x), y: Math.round(y) });
    await sleep(24);
  };

  const results = {};

  // Kenar cubugu acik, arac paneli acik olsun. Genislik BILINEN bir degere
  // cekilir: onceki kosudan kalan localStorage degeri paneli en dar olcude
  // birakirsa daraltacak yer kalmaz ve test yanlislikla dusr.
  await js(`(()=>{document.getElementById('sidebar').classList.remove('hidden');
    const p=document.getElementById('tool-panel');
    if(p.classList.contains('closed'))document.getElementById('btn-tools').click();
    try{localStorage.setItem('ajan.tool.width','620');}catch(e){}
    document.documentElement.style.setProperty('--tool-width','620px');
    return true})()`);
  await sleep(700);

  const durum = await js(`(()=>{
    const p=document.getElementById('tool-panel'),h=document.getElementById('tool-resizer');
    const pr=p.getBoundingClientRect(),hr=h.getBoundingClientRect();
    return {panelGenislik:Math.round(pr.width),
            tutamak:{x:Math.round(hr.left+hr.width/2),y:Math.round(hr.top+hr.height/2),genislik:Math.round(hr.width)},
            gorunur:hr.width>0&&getComputedStyle(h).display!=='none'};
  })()`);
  results.tutamakGorunur = durum.gorunur;
  results.baslangicGenislik = durum.panelGenislik;
  if (!durum.gorunur) return results;

  // ---- Surukleme: tutamagi 120px SAGA cek, panel daralmali ----
  // (Genisletme yonu pencere darsa ust sinira takilabilir; daraltma her
  //  pencere boyunda olculebilir.)
  const x0 = durum.tutamak.x, y0 = durum.tutamak.y;
  await move(x0, y0);
  wc.sendInputEvent({ type: "mouseDown", x: x0, y: y0, button: "left", clickCount: 1 });
  await sleep(60);
  results.tani = await js(`(()=>{
    const h=document.getElementById('tool-resizer'),hr=h.getBoundingClientRect();
    return {suruklemeSinifi:document.body.classList.contains('split-resizing'),
            sayfaGenislik:window.innerWidth, devicePixelRatio:window.devicePixelRatio,
            tutamakRect:{sol:Math.round(hr.left),ust:Math.round(hr.top),gen:Math.round(hr.width),yuk:Math.round(hr.height)},
            noktadakiOge:(()=>{const e=document.elementFromPoint(${x0},${y0});return e?(e.id||e.tagName+'.'+e.className):null})()};
  })()`);

  const araOlcumler = [];
  for (let adim = 1; adim <= 6; adim++) {
    const x = x0 + adim * 20;
    await move(x, y0);
    const olcum = await js(`(()=>{const p=document.getElementById('tool-panel').getBoundingClientRect();
      return {w:Math.round(p.width),sol:Math.round(p.left)};})()`);
    araOlcumler.push({ fareX: x, panelGenislik: olcum.w, panelSol: olcum.sol });
  }
  results.suruklemeOlcumleri = araOlcumler;

  const beklenen = results.baslangicGenislik - 120;
  const gerceklesen = araOlcumler.at(-1).panelGenislik;
  results.hedefGenislik = beklenen;
  results.suruklemeSonuGenislik = gerceklesen;
  // Gecikme testi: panel imlecin 24px'inden fazla gerisinde kalmamali.
  results.imleceYapisik = Math.abs(gerceklesen - beklenen) <= 24;

  // ---- Birakma: fareyi kaldir ----
  const sonX = x0 + 120;
  wc.sendInputEvent({ type: "mouseUp", x: sonX, y: y0, button: "left", clickCount: 1 });
  await sleep(250);
  const birakmaSonrasi = await js(`(()=>Math.round(document.getElementById('tool-panel').getBoundingClientRect().width))()`);
  results.birakmaAnindakiGenislik = birakmaSonrasi;
  results.suruklemeSinifiTemiz = await js(`!document.body.classList.contains('split-resizing')`);

  // ---- Kritik: birakildiktan SONRA hareket paneli degistirmemeli ----
  for (let adim = 1; adim <= 5; adim++) await move(sonX + adim * 30, y0);
  await sleep(200);
  const sonrakiGenislik = await js(`(()=>Math.round(document.getElementById('tool-panel').getBoundingClientRect().width))()`);
  results.birakmadanSonrakiGenislik = sonrakiGenislik;
  results.birakincaDurdu = sonrakiGenislik === birakmaSonrasi;

  return results;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: true, webPreferences: { sandbox: false, backgroundThrottling: false } });
  let out = { ok: false };
  try {
    win.focus();
    await win.loadURL(URL_TO_TEST);
    // Arayuz gercekten cizilene kadar bekle (did-finish-load beklenmez).
    for (let i = 0; i < 60; i++) {
      const hazir = await win.webContents.executeJavaScript(
        `!!document.getElementById('tool-resizer') && !!document.getElementById('btn-tools')`, true).catch(() => false);
      if (hazir) break;
      await sleep(250);
    }
    out = { ok: true, ...(await run(win)) };
  } catch (error) {
    out = { ok: false, error: String(error && error.message || error) };
  }
  process.stdout.write("E2E_RESULT:" + JSON.stringify(out) + "\n");
  app.exit(0);
});
