import test from "node:test";
import assert from "node:assert/strict";
import { isExplicitPublishRequest, parseBrowserAction, parseHostAction } from "../src/orchestrator.js";

test("all providers use the same structured browser action protocol",()=>{
  assert.deepEqual(parseBrowserAction('<<<AJAN_BROWSER_ACTION>>>{"action":"open","payload":{"url":"https://example.com"}}<<<END>>>'),{action:"open",payload:{url:"https://example.com"}});
  assert.deepEqual(parseBrowserAction('<<<AJAN_BROWSER_ACTION>>>{"action":"snapshot","payload":{}}<<<END>>>'),{action:"snapshot",payload:{}});
  assert.equal(parseBrowserAction("curl http://127.0.0.1:4780"),null);
});

test("explicit publish requests use the host action protocol",()=>{
  assert.deepEqual(parseHostAction('<<<AJAN_HOST_ACTION>>>{"action":"publish","payload":{}}<<<END>>>'),{action:"publish",payload:{}});
  assert.equal(parseHostAction('<<<AJAN_HOST_ACTION>>>{"action":"force-push","payload":{}}<<<END>>>'),null);
  assert.equal(isExplicitPublishRequest("şimdi baştan GitHub'a girip yayımlamayı tekrar dene"),true);
  assert.equal(isExplicitPublishRequest("GitHub durumuna bak"),false);
});

// ---- Jeton kullaniciya gorunmez (kullanici ekraninda ana yazi olarak akti) ----

test("stripActionTokens jeton bloklarini ve yarim kuyrugu ayiklar", async () => {
  const { stripActionTokens } = await import("../src/orchestrator.js");
  const tam = 'Önce bakayım.\n<<<AJAN_BROWSER_ACTION>>>{"action":"open","payload":{"url":"file:///x/index.html"}}<<<END>>>\nsonra devam.';
  assert.equal(stripActionTokens(tam), "Önce bakayım.\n\nsonra devam.");
  assert.equal(stripActionTokens('<<<AJAN_HOST_ACTION>>>{"action":"publish"'), "", "yarim kuyruk da gitmeli");
  assert.equal(stripActionTokens("normal yazı"), "normal yazı");
});

test("describeAgentAction eylemi Turkce baslikli adima cevirir", async () => {
  const { describeAgentAction } = await import("../src/orchestrator.js");
  assert.deepEqual(describeAgentAction({action:"open",payload:{url:"file:///Users/x/deneme/index.html"}}),
    {kind:"tarayici",title:"index.html tarayıcıda açıldı"});
  assert.deepEqual(describeAgentAction({action:"snapshot",payload:{}}),{kind:"tarayici",title:"Sayfa incelendi"});
  assert.equal(describeAgentAction({action:"publish",payload:{}}).title, "GitHub'a yayınlandı");
  assert.equal(describeAgentAction({action:"navigate",payload:{url:"https://ornek.dev/yol"}}).title, "ornek.dev/yol sayfasına gidildi");
});

test("orkestrator eylemi adim gunlugune yazar ve nihai metni temizler", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../src/orchestrator.js", import.meta.url), "utf8");
  assert.match(src, /describeAgentAction\(action\)/, "eylem adim satirina cevrilmeli");
  assert.match(src, /stepLog\.add\(tarif\.kind/, "adim gunlugune yazilmali");
  assert.match(src, /stripActionTokens\(res\.text\)/, "nihai yanit jetondan arindirilmali");
  const ui = fs.readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
  assert.match(ui, /<<<AJAN_\\w\+>>>/, "arayuz canli/kayitli metinden jetonu suzmeli");
});
