import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { contextWindowFor } from "../src/models.js";
import { extractSummary, stripSummaryBlock, summaryContract, SUMMARY_OPEN, SUMMARY_CLOSE } from "../src/util.js";

// --- 1) Bağlam bütçesi ---
test("bağlam penceresi modele göre çözülür, bilinmeyen sağlayıcı 0 döner", () => {
  assert.equal(contextWindowFor("claude", "claude-fable-5"), 1_000_000);
  assert.equal(contextWindowFor("claude", "sonnet"), 200_000);
  assert.equal(contextWindowFor("claude", ""), 200_000, "model boşken varsayılan pencere");
  assert.equal(contextWindowFor("codex", "gpt-5.4-mini"), 128_000);
  assert.equal(contextWindowFor("antigravity", ""), 0, "köprü sağlayıcısında kullanım verisi yok");
  assert.equal(contextWindowFor("bilinmeyen", "x"), 0);
});

test("oturum doluluğu son çağrının girdi+önbellek toplamından hesaplanır", () => {
  const orch = fs.readFileSync(new URL("../src/orchestrator.js", import.meta.url), "utf8");
  assert.match(orch, /trackSessionContext\(run, member, usage\)/);
  // Doluluk vekili: input + cachedInput (oturumda yeniden gönderilen tüm konuşma)
  assert.match(orch, /Number\(usage\.input \|\| 0\) \+ Number\(usage\.cachedInput \|\| 0\)/);
  // Her çağrıda güncellenir
  assert.match(orch, /this\.accumUsage\(run, member\.id, u\); this\.trackSessionContext\(run, member, u\)/);
  // Yüzde hesabı pencereye göre ve 100 ile sınırlı
  assert.match(orch, /Math\.min\(100, Math\.round\(\(tokens \/ limit\) \* 100\)\)/);
});

test("oturum tazeleme devir teslim notu alır, oturumu siler ve sayacı sıfırlar", () => {
  const orch = fs.readFileSync(new URL("../src/orchestrator.js", import.meta.url), "utf8");
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
  assert.match(orch, /async refreshMemberSession\(run, memberId\)/);
  assert.match(orch, /Devir teslim notu yaz/);
  assert.match(orch, /provider\.sessions\.delete\(key\)/);
  assert.match(orch, /delete run\.sessionContext\[member\.id\]/);
  // Yeni oturum devir teslim notuyla tohumlanır
  assert.match(orch, /run\.sessionHandoff\?\.\[mem\.id\]/);
  assert.match(server, /\\\/api\\\/runs\\\/\(\[\\w-\]\+\)\\\/session\\\/refresh/);
  assert.match(app, /data-refresh-session/);
});

// --- 2) Özet sözleşmesi ---
test("özet bloğu ayıklanır ve kullanıcıya gösterilen metinden çıkarılır", () => {
  const text = `Uzun analiz metni.\n\n${SUMMARY_OPEN}\n- Repo haritası eklendi\n- src/projectContext.js\n${SUMMARY_CLOSE}`;
  assert.equal(extractSummary(text), "- Repo haritası eklendi\n- src/projectContext.js");
  assert.equal(stripSummaryBlock(text), "Uzun analiz metni.");
  // Blok yoksa güvenli davranış
  assert.equal(extractSummary("düz metin"), null);
  assert.equal(stripSummaryBlock("düz metin"), "düz metin");
  // Kapanış etiketi eksikse yine de ayıklar
  assert.equal(extractSummary(`x\n${SUMMARY_OPEN}\n- yarım`), "- yarım");
});

test("özet sözleşmesi görev istemine eklenir ve sonuç özeti saklanır", () => {
  const orch = fs.readFileSync(new URL("../src/orchestrator.js", import.meta.url), "utf8");
  assert.match(summaryContract(), /EN SONUNA/);
  assert.match(orch, /header \+ prepared\.prompt \+ summaryContract\(\)/);
  assert.match(orch, /task\.summary = extractSummary\(res\.text\) \|\| truncate\(res\.text, 700\)/);
  assert.match(orch, /task\.result = stripSummaryBlock\(res\.text\)/);
});

test("özet varsa tam metin yerine iç bağlamda özet taşınır", () => {
  const coord = fs.readFileSync(new URL("../src/coordinator.js", import.meta.url), "utf8");
  const orch = fs.readFileSync(new URL("../src/orchestrator.js", import.meta.url), "utf8");
  const store = fs.readFileSync(new URL("../src/store.js", import.meta.url), "utf8");
  // Koordinatör özeti
  assert.match(coord, /m\.summary \? m\.summary : truncate\(m\.content, 3500\)/);
  // Tartışma ve oylama bağlamı
  assert.match(orch, /m\.summary \|\| truncate\(m\.content, 3000\)/);
  assert.match(orch, /t\.summary \|\| truncate\(t\.result, 2000\)/);
  // Mesajda taşınır
  assert.match(store, /summary,\s+\/\/ uzun sonuçların kısa özeti/);
});
