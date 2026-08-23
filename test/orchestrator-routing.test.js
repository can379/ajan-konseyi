import test from "node:test";
import assert from "node:assert/strict";
import { Orchestrator, reportsBlockedResult } from "../src/orchestrator.js";

const members = [
  { id: "m-claude", name: "Claude", provider: "claude", enabled: true },
  { id: "m-antigravity", name: "Antigravity", provider: "antigravity", enabled: true },
];

test("kullanıcının açık ajan tercihi diğer ajanlara devredilmez", () => {
  const orch = Object.create(Orchestrator.prototype);
  assert.equal(
    orch.explicitlyRequestedMember("dur dur bunu antigravity yapsın claude değil", members)?.id,
    "m-antigravity",
  );
  assert.equal(
    orch.explicitlyRequestedMember("bunu antigravitiy yapsın claude değil", members)?.id,
    "m-antigravity",
  );
  assert.equal(orch.explicitlyRequestedMember("@Claude bunu incele", members)?.id, "m-claude");
});

test("normal mesajda ajan tercihi uydurulmaz", () => {
  const orch = Object.create(Orchestrator.prototype);
  assert.equal(orch.explicitlyRequestedMember("bu görseli ayrıntılı incele", members), null);
});

test("ajan erişim engelini sonuç gibi yazarsa görev başarılı sayılmaz",()=>{
  assert.equal(reportsBlockedResult("Durum: bloke — iki yetki eksik\nHiçbir değişiklik uygulanmadı."),true);
  assert.equal(reportsBlockedResult("Değişiklik uygulayamadım; çalışma alanı salt okunur."),true);
  assert.equal(reportsBlockedResult("Düzeltme uygulandı ve testler başarılı."),false);
});

test("görsel isteği native ve fotogerçekçi kalite sözleşmesiyle güçlendirilir", () => {
  const orch = Object.create(Orchestrator.prototype);
  const prompt = orch.imageGenerationPrompt("elinde çiçek tutan sevimli kedi görseli oluştur");
  assert.match(prompt, /generate_image/);
  assert.match(prompt, /fotogerçekçi/);
  assert.match(prompt, /SVG.*kullanma/s);
});

test("açık illüstrasyon isteği fotogerçekçiliğe zorlanmaz", () => {
  const orch = Object.create(Orchestrator.prototype);
  const prompt = orch.imageGenerationPrompt("vektör bir kedi illüstrasyonu oluştur");
  assert.match(prompt, /illüstrasyon\/vektör stilini koru/);
  assert.doesNotMatch(prompt, /varsayılan sonuç fotogerçekçi/);
});

test("açık adet yoksa tek görsel, varsa en fazla otuz görsel istenir", () => {
  const orch = Object.create(Orchestrator.prototype);
  assert.equal(orch.requestedImageCount("bir kedi görseli oluştur"), 1);
  assert.equal(orch.requestedImageCount("12 adet kedi görseli oluştur"), 12);
  assert.equal(orch.requestedImageCount("99 tane görsel oluştur"), 30);
});

test("görsel hakkında soru ve olumsuzlama üretim başlatmaz", () => {
  const orch = Object.create(Orchestrator.prototype);
  assert.equal(orch.isImageGenerationRequest("Görsel oluşturabiliyor musun?"), false);
  assert.equal(orch.isImageGenerationRequest("Bunu Codex oluşturdu, sen oluşturmadın."), false);
  assert.equal(orch.isImageGenerationRequest("Sana görsel oluşturabiliyor musun diye sordum; oluştur demedim."), false);
  assert.equal(orch.isImageGenerationRequest("Görsel üretme yeteneğini değerlendir ve cevap ver."), false);
});

test("yalnız açık görsel üretim talebi otomatik üretimi başlatır", () => {
  const orch = Object.create(Orchestrator.prototype);
  assert.equal(orch.isImageGenerationRequest("Elinde çiçek tutan kedi görseli oluştur"), true);
  assert.equal(orch.isImageGenerationRequest("Benim için bunu poster olarak tasarlayabilir misin?"), true);
  assert.equal(orch.isImageGenerationRequest("Yağmurlu İstanbul fotoğrafı istiyorum"), true);
});
