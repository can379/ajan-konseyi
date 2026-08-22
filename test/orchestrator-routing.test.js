import test from "node:test";
import assert from "node:assert/strict";
import { Orchestrator } from "../src/orchestrator.js";

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
