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

// ---- Eklerin okunabilirligi: uploads proje disinda ----
test("Claude cagrisina ek dizinleri --add-dir olarak gecer", async () => {
  const { ClaudeAgent } = await import("../src/agents/claudeAgent.js");
  const agent = Object.create(ClaudeAgent.prototype);
  Object.assign(agent, {
    rootDir: process.cwd(), bin: "claude", getSession: () => null,
    getModel: () => "", getEffort: () => "", progress() {}, setSession() {},
  });
  let gorulen = null;
  agent.spawnCollect = async (_bin, args, _stdin, _cwd, _t, onLine) => {
    gorulen = args;
    onLine(JSON.stringify({ type: "result", result: "ok", usage: {} }));
    return { code: 0, timedOut: false, stdout: "", stderr: "" };
  };
  // Kullanicinin yasadigi hata: ekler ~/Library/.../uploads icinde, proje
  // disinda. --add-dir verilmeyince Claude "calisma kopyamin disinda ve
  // okuma izni verilmedi" diyip acamiyordu.
  await agent.invoke("eki oku", { readRoots: ["/veri/uploads", "/veri/generated"] });
  const i = gorulen.indexOf("--add-dir");
  assert.ok(i > -1, "--add-dir bulunmalı");
  assert.equal(gorulen[i + 1], "/veri/uploads");
  assert.equal(gorulen[gorulen.lastIndexOf("--add-dir") + 1], "/veri/generated");
});

test("orkestrator her uye cagrisinda readRoots verir", async () => {
  const fs = await import("node:fs");
  const kaynak = fs.readFileSync(new URL("../src/orchestrator.js", import.meta.url), "utf8");
  assert.match(kaynak, /readRoots: \[`\$\{this\.rootDir\}\/uploads`, `\$\{this\.rootDir\}\/generated`\]/);
});
