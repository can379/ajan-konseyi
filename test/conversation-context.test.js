import test from "node:test";
import assert from "node:assert/strict";
import { Orchestrator, isIdentityQuestion } from "../src/orchestrator.js";

const ctx = (messages) =>
  Orchestrator.prototype.sharedConversationContext.call(
    { conversationHistoryMessages: Orchestrator.prototype.conversationHistoryMessages },
    { messages },
  );

test("arastirma sorusu kimlik sorusu sayilmaz", () => {
  assert.equal(isIdentityQuestion("şimdi bu bizim yazılımın yaptığı işi yapan büyük yazılımları analiz et. ve onlardan ne eksiğimiz var"), false);
  assert.equal(isIdentityQuestion("Sen kimsin?"), true);
  assert.equal(isIdentityQuestion("hangi model kullanıyorsun"), true);
});

test("bos yanit ve saglayici hata satirlari baglama girmez", () => {
  const text = ctx([
    { from: "kullanici", kind: "message", content: "analiz et" },
    { from: "ox", fromLabel: "Ox Alpha", kind: "message", content: "   " },
    { from: "sistem", kind: "error", content: "Tur hatayla bitti: Ox Alpha yanıt veremedi: OpenRouter 429" },
    { from: "sistem", kind: "info", content: "Ox Alpha yanıt veremedi: OpenRouter zaman aşımı" },
    { from: "ox", fromLabel: "Ox Alpha", kind: "message", content: "gercek yanit" },
  ]);
  assert.match(text, /gercek yanit/);
  assert.doesNotMatch(text, /429|zaman aşımı|Tur hatayla bitti/);
});

test("ayni kullanici sorusunun tekrari yalniz son haliyle kalir", () => {
  const soru = "@Ox Alpha: analiz et";
  const text = ctx([
    { from: "kullanici", kind: "message", content: soru },
    { from: "ox", fromLabel: "Ox Alpha", kind: "message", content: "ilk deneme" },
    { from: "kullanici", kind: "message", content: soru },
    { from: "kullanici", kind: "message", content: soru },
  ]);
  assert.equal(text.split(soru).length - 1, 1, "tekrar eden soru bir kez kalmali");
  assert.doesNotMatch(text, /ilk deneme/, "silinen tekrarin yaniti da kalmamali");
});

test("silinen tekrarin yaniti da baglamdan cikar", () => {
  const soru = "@Ox Alpha: analiz et";
  const text = ctx([
    { from: "kullanici", kind: "message", content: soru },
    { from: "ox", fromLabel: "Ox Alpha", kind: "message", content: "konudan sapan eski yanit" },
    { from: "kullanici", kind: "message", content: soru },
  ]);
  assert.doesNotMatch(text, /konudan sapan eski yanit/);
  assert.match(text, /analiz et/);
});

test("son sorunun yaniti korunur", () => {
  const text = ctx([
    { from: "kullanici", kind: "message", content: "ilk soru" },
    { from: "ox", fromLabel: "Ox Alpha", kind: "message", content: "ilk yanit" },
    { from: "kullanici", kind: "message", content: "ikinci soru" },
    { from: "ox", fromLabel: "Ox Alpha", kind: "message", content: "ikinci yanit" },
  ]);
  assert.match(text, /ilk yanit/);
  assert.match(text, /ikinci yanit/);
});
