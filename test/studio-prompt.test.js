import test from "node:test";
import assert from "node:assert/strict";
import { Orchestrator, studioEnhancementPrompt } from "../src/orchestrator.js";

test("kısa video fikri süre ve sinema ayrıntılarıyla profesyonel prompt görevine dönüşür",()=>{
  const prompt=studioEnhancementPrompt({text:"yağmurda İstanbul",mediaKind:"video",engine:"veo-3.1",aspect:"16:9",quality:"4k",duration:"8",hasReferences:true});
  assert.match(prompt,/8 saniye/); assert.match(prompt,/kamera hareketi/); assert.match(prompt,/referansı doğrudan düzenleme/); assert.match(prompt,/yağmurda İstanbul/);
});

test("görsel güçlendirme açıklama değil yalnız nihai prompt ister",()=>{
  const prompt=studioEnhancementPrompt({text:"beyaz kedi",mediaKind:"image"});
  assert.match(prompt,/Yalnız nihai promptu yaz/); assert.match(prompt,/Kompozisyon/);
});

test("geçici prompt güçlendirme kullanımı state dosyası yazmaya çalışmaz",()=>{
  let saves=0; const orch=Object.create(Orchestrator.prototype); orch.store={saveRun(){saves++;}};
  const run={transient:true,usage:{}}; orch.accumUsage(run,"codex",{input:4,output:2});
  assert.equal(saves,0); assert.equal(run.usage.codex.calls,1);
});
