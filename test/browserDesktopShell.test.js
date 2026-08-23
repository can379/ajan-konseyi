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
