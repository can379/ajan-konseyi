import test from "node:test";
import assert from "node:assert/strict";
import { conversationTitle } from "../src/util.js";

test("sohbet başlığı ajan etiketi ve dolgu sözcükleri olmadan üretilir", () => {
  assert.equal(conversationTitle("@Antigravity: bana elinde çiçek tutan kedi görseli oluştur"), "Elinde çiçek tutan kedi görseli oluştur");
});

test("uzun sohbet başlığı kelime sınırında kısaltılır", () => {
  const title = conversationTitle("Bu çok uzun konuşmada kullanıcıların geçmiş mesajlarını arayabilecekleri modern bir alan oluştur ve doğrula", 42);
  assert.ok(title.length <= 43);
  assert.match(title, /…$/);
});
