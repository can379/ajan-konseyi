import test from "node:test";
import assert from "node:assert/strict";
import { detectMedia, attachmentPrompt, unsupportedAttachments } from "../src/media.js";

test("dosya imzası yanlış MIME bildirimini düzeltir", () => {
  const png = Buffer.from([137,80,78,71,13,10,26,10,0]);
  const m = detectMedia(png, "foto.bin", "application/octet-stream");
  assert.equal(m.mime, "image/png"); assert.equal(m.kind, "image");
});

test("belge içeriği ajan istemine yapılandırılmış eklenir", () => {
  const p = attachmentPrompt([{name:"not.md",kind:"text",mime:"text/markdown",size:12,path:"/tmp/not.md",extractedText:"merhaba"}]);
  assert.match(p,/not\.md/); assert.match(p,/merhaba/);
});

test("ortak medya katmanı tüm sağlayıcılara ekleri ulaştırır", () => {
  assert.equal(unsupportedAttachments("codex", [{kind:"audio",name:"x.wav"}]).length, 0);
  assert.equal(unsupportedAttachments("claude", [{kind:"video",name:"x.mp4"}]).length, 0);
  assert.equal(unsupportedAttachments("antigravity", [{kind:"audio",name:"x.wav"}]).length, 0);
});

test("bilinmeyen dosya türleri de hiçbir sağlayıcıda reddedilmez", () => {
  const unknown = detectMedia(Buffer.from([0,1,2,3]), "ornek.blob");
  assert.equal(unknown.kind, "file");
  for (const provider of ["codex", "claude", "antigravity"]) {
    assert.equal(unsupportedAttachments(provider, [unknown]).length, 0);
  }
});

test("sunum ve yaygın arşiv türleri doğru sınıflandırılır", () => {
  assert.equal(detectMedia(Buffer.from("x"), "sunum.pptx").kind, "document");
  assert.equal(detectMedia(Buffer.from("x"), "paket.7z").kind, "archive");
});
