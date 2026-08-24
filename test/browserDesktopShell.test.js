import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const main=fs.readFileSync(new URL("../desktop/main.cjs",import.meta.url),"utf8");
const preload=fs.readFileSync(new URL("../desktop/preload.cjs",import.meta.url),"utf8");
const ui=fs.readFileSync(new URL("../ui/app.js",import.meta.url),"utf8");
const html=fs.readFileSync(new URL("../ui/index.html",import.meta.url),"utf8");

test("OAuth popup istekleri reddedilmek yerine uygulama sekmesine aktarılır",()=>{
  assert.match(main,/setWindowOpenHandler\(\(\{url\}\).*browser-new-tab/);
  assert.match(preload,/onBrowserNewTab/);
  assert.match(ui,/onBrowserNewTab/);
});

test("masaüstü tarayıcı sekme ve gezinme kontrollerini içerir",()=>{
  for(const id of ["browser-tabs","browser-new-tab","browser-back","browser-forward","browser-reload","browser-url"])assert.match(html,new RegExp(`id="${id}"`));
  assert.match(ui,/did-navigate-in-page/);
  assert.match(ui,/setActiveBrowserGuest/);
  assert.match(ui,/createBrowserTab/);
});

test("sol kenar çubuğu yatay kaydırma üretmez",()=>{
  const css=fs.readFileSync(new URL("../ui/style.css",import.meta.url),"utf8");
  assert.match(css,/#sidebar[^}]*overflow-x:\s*hidden/s);
  assert.match(css,/\.project-item \.p-name, \.run-item \.r-title[^}]*text-overflow:\s*ellipsis/s);
});

test("proje sohbetleri ortak sohbet menüsünü kullanır ve olayları proje satırına taşımaz",()=>{
  for(const action of ["rename","pin","transfer","tags","export","replay","archive","trash"]){
    assert.match(html,new RegExp(`data-run-menu="${action}"`));
  }
  // Proje ici ve proje disi sohbetler TEK paylasilan delegasyon bilesenini kullanir.
  assert.match(ui,/bindRunContextMenu\(el\)/);
  assert.match(ui,/bindRunContextMenu\(listEl\)/);
  assert.match(ui,/function bindSidebarMenus\(\)/);
  assert.match(ui,/sidebar\.addEventListener\("pointerover"/);
  // Sohbet tiklamasi proje satirina ve belge dinleyicilerine tasmaz.
  assert.match(ui,/event\.stopPropagation\(\)/);
  // Sohbet satiri her zaman onceliklidir: proje menusu kapatilir.
  assert.match(ui,/hideProjectMenu\(\)/);
  // Satirdan menuye gecerken kapanmayi engelleyen relatedTarget kontrolu.
  assert.match(ui,/const next=event\.relatedTarget/);
});

test("sohbet menüsü viewport içinde fixed konumlanır ve masaüstünde paneli kapatmaz",()=>{
  const css=fs.readFileSync(new URL("../ui/style.css",import.meta.url),"utf8");
  assert.match(css,/#run-context-menu\{position:fixed\}/);
  // Menu viewport icinde sinirlanir.
  assert.match(ui,/Math\.max\(pad,Math\.min\(rect\.top-4,window\.innerHeight-height-pad\)\)/);
  // Otomatik kapanma yalniz gercek mobil genislikte.
  assert.match(ui,/if \(!window\.desktopAPI && window\.matchMedia\("\(max-width: 760px\)"\)\.matches\)/);
  // Capa satirin gorunur sag kenariyla sinirlanir; menu ortada acilmaz.
  assert.match(ui,/const anchorRight=bounds\?Math\.min\(rect\.right,bounds\.right\):rect\.right/);
  // Render sonrasi hover son fare konumundan geri kazanilir.
  assert.match(ui,/document\.elementFromPoint\(lastPointer\.x,lastPointer\.y\)/);
});
