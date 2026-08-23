import test from "node:test";
import assert from "node:assert/strict";
import { bridgePrompt, connectorAccessMode, connectorCatalog, connectorRoute, requestedConnector } from "../src/connectorBridge.js";
import { Orchestrator, identityResponseMatchesProvider, isIdentityQuestion, verifiedMemberIdentity } from "../src/orchestrator.js";

test("servis adını görevden algılar", () => {
  assert.equal(requestedConnector("Canva'da yeni bir afiş oluştur"), "canva");
  assert.equal(requestedConnector("GitHub pull requestlerini incele"), "github");
  assert.equal(requestedConnector("normal kodu incele"), null);
});

test("kod ve git yapılandırmasındaki email metnini Gmail isteği saymaz",()=>{
  assert.equal(requestedConnector("git -c user.email=ajan@example.com commit oluştur"),null);
  assert.equal(requestedConnector("Formdaki email alanını doğrula"),null);
  assert.equal(requestedConnector("Önceki görevde e-posta yapılandırması yapıldı"),null);
  assert.equal(requestedConnector("Gmail gelen kutusunu incele"),"gmail");
  assert.equal(requestedConnector("E-postaları listele"),"gmail");
});

test("bağlayıcı erişim modu okumayı yazmadan ayırır",()=>{
  assert.equal(connectorAccessMode("gmail","Gmail gelen kutusunu incele"),"read");
  assert.equal(connectorAccessMode("gmail","Gmail ile yanıt gönder"),"write");
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

test("geçmişteki bağlayıcı sözcüğü Ox Alpha mesajını Codex'e yönlendirmez", async () => {
  let called = "";
  const orchestrator = Object.create(Orchestrator.prototype);
  orchestrator.rootDir = process.cwd();
  orchestrator.store = { setAgentStatus(){}, streamProgress(){} };
  orchestrator.config = { data:{ members:[{ id:"m-ox-alpha", name:"Ox Alpha", provider:"openrouter", enabled:true }] } };
  orchestrator.providers = {
    openrouter:{ async send(){ called="openrouter"; return { ok:true, text:"Ox Alpha", raw:{} }; } },
    codex:{ async send(){ called="codex"; return { ok:true, text:"Codex", raw:{} }; } },
  };
  const member = orchestrator.config.data.members[0];
  const run = { id:"run-identity", messages:[], stopRequested:false, usage:{} };

  const result = await orchestrator.callMember(
    run,
    member,
    "Eski geçmiş: GitHub deposu incelendi.\n\nSen kimsin kardeş?",
    { routeText:"Sen kimsin kardeş?" },
  );

  assert.equal(called, "openrouter");
  assert.equal(result.text, "Ox Alpha");
  assert.equal(result.raw.connectorRoute, undefined);
});

test("bağımlılık çıktısındaki user.email saf görev yönlendirmesini kirletmez",async()=>{
  let called="",leaseCalls=0;
  const orchestrator=Object.create(Orchestrator.prototype);
  orchestrator.rootDir=process.cwd();
  orchestrator.store={setAgentStatus(){},streamProgress(){}};
  orchestrator.config={data:{members:[{id:"m-claude",name:"Claude",provider:"claude",enabled:true}]}};
  orchestrator.providers={
    claude:{async send(){called="claude";return{ok:true,text:"analiz",raw:{}};}},
    codex:{async send(){called="codex";return{ok:true,text:"gmail",raw:{}};}},
  };
  orchestrator.acquireAgentLease=()=>{leaseCalls++;return null;};
  const run={id:"run-dependency",messages:[],stopRequested:false,usage:{}};
  const result=await orchestrator.callMember(run,orchestrator.config.data.members[0],
    "Önceki çıktı: git -c user.email=ajan@example.com commit oluştur\nProjeyi analiz et",
    {routeText:"Projeyi analiz et"});
  assert.equal(result.ok,true);
  assert.equal(called,"claude");
  assert.equal(leaseCalls,0);
});

test("salt okunur Gmail çağrısı özel lease almaz",async()=>{
  let leaseCalls=0;
  const orchestrator=Object.create(Orchestrator.prototype);
  orchestrator.rootDir=process.cwd();
  orchestrator.store={setAgentStatus(){},streamProgress(){}};
  orchestrator.config={data:{members:[{id:"m-codex",name:"Codex",provider:"codex",enabled:true}]}};
  orchestrator.providers={codex:{async send(){return{ok:true,text:"ok",raw:{}};}}};
  orchestrator.acquireAgentLease=()=>{leaseCalls++;return null;};
  const run={id:"run-read",messages:[],stopRequested:false,usage:{}};
  await orchestrator.callMember(run,orchestrator.config.data.members[0],"Gmail gelen kutusunu incele",{routeText:"Gmail gelen kutusunu incele"});
  assert.equal(leaseCalls,0);
});

test("kimlik soruları sağlayıcıya özel ve temiz oturumda çalışır", async () => {
  let called = "", receivedOpts;
  const orchestrator = Object.create(Orchestrator.prototype);
  orchestrator.rootDir = process.cwd();
  orchestrator.store = { setAgentStatus(){}, streamProgress(){} };
  orchestrator.config = { data:{ members:[{ id:"m-claude", name:"Claude", provider:"claude", enabled:true }] } };
  orchestrator.providers = {
    claude:{ async send(_prompt, opts){ called="claude"; receivedOpts=opts; return { ok:true, text:"Ben Codex'im.", raw:{} }; } },
    codex:{ async send(){ called="codex"; return { ok:true, text:"Codex", raw:{} }; } },
  };
  const run = { id:"run-claude-identity", messages:[{ from:"sistem", content:"GitHub ortak köprü" }], stopRequested:false, usage:{} };
  const result = await orchestrator.callMember(run, orchestrator.config.data.members[0], "@Claude: sen kimsin", { routeText:"@Claude: sen kimsin" });

  assert.equal(called, "claude");
  assert.equal(receivedOpts.fresh, true);
  assert.match(result.text, /Ben \*\*Claude\*\*'um/);
  assert.equal(result.raw.identityCorrected, true);
});

test("kimlik yardımcıları tüm sağlayıcıları birbirinden ayırır", () => {
  assert.equal(isIdentityQuestion("@Antigravity: sen kimsin?"), true);
  assert.equal(identityResponseMatchesProvider({ provider:"claude" }, "Ben Codex'im"), false);
  assert.match(verifiedMemberIdentity({ provider:"antigravity" }), /Antigravity/);
  assert.match(verifiedMemberIdentity({ provider:"openrouter" }), /stealth\/ox-alpha/);
});
