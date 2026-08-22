import test from "node:test";
import assert from "node:assert/strict";
import { bridgePrompt, connectorCatalog, connectorRoute, requestedConnector } from "../src/connectorBridge.js";
import { Orchestrator } from "../src/orchestrator.js";

test("servis adını görevden algılar", () => {
  assert.equal(requestedConnector("Canva'da yeni bir afiş oluştur"), "canva");
  assert.equal(requestedConnector("GitHub pull requestlerini incele"), "github");
  assert.equal(requestedConnector("normal kodu incele"), null);
});

test("Claude yerel bağlayıcısını, eksik olanlarda Codex köprüsünü kullanır", () => {
  assert.deepEqual(connectorRoute("claude", "Figma dosyasını incele"), { connector:"figma", mode:"direct", provider:"claude" });
  assert.deepEqual(connectorRoute("claude", "Canva tasarımını aç"), { connector:"canva", mode:"shared", provider:"codex", requestedProvider:"claude" });
});

test("Antigravity servis görevlerini ortak köprüye yollar", () => {
  assert.deepEqual(connectorRoute("antigravity", "Drive belgesini bul"), { connector:"google-drive", mode:"shared", provider:"codex", requestedProvider:"antigravity" });
});

test("köprü promptu gerçek araç kullanımını ve güvenlik sınırını zorunlu kılar", () => {
  const text=bridgePrompt(connectorRoute("claude", "Gmail'de ara"), "Gmail'de ara");
  assert.match(text,/resmi Gmail eklentisini\/aracını gerçekten kullan/i);
  assert.match(text,/veri değiştirme/i);
});

test("katalog paylaşılan yolları açıkça gösterir", () => {
  const catalog=connectorCatalog();
  assert.equal(catalog.canva.providers.claude.status,"via-codex");
  assert.equal(catalog.slack.providers.claude.status,"connected");
  assert.equal(catalog.github.providers.antigravity.mode,"shared");
});

test("orkestratör Claude Canva görevini aynı üye adına Codex'e devreder", async () => {
  let called="", received="";
  const store={
    setAgentStatus(){}, streamProgress(){},
  };
  const orchestrator=Object.create(Orchestrator.prototype);
  orchestrator.rootDir=process.cwd();
  orchestrator.store=store;
  orchestrator.config={data:{members:[{id:"m-claude",name:"Claude",provider:"claude",enabled:true}]}};
  orchestrator.providers={
    claude:{send(){ throw new Error("Claude doğrudan çağrılmamalı"); }},
    codex:{async send(prompt){ called="codex"; received=prompt; return {ok:true,text:"Canva sonucu",raw:{}}; }},
  };
  const run={id:"run-1",messages:[],stopRequested:false};
  const result=await orchestrator.callMember(run,orchestrator.config.data.members[0],"Canva'da afiş oluştur");
  assert.equal(called,"codex");
  assert.equal(result.text,"Canva sonucu");
  assert.equal(result.raw.connectorRoute.connector,"canva");
  assert.match(received,/ORTAK BAĞLAYICI KÖPRÜSÜ/);
});
