import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolveTurnRoute } from "../src/orchestrator.js";

const require = createRequire(import.meta.url);
const { SLASH_COMMANDS, filterSlashCommands, parseSlashInput } = require("../ui/commands.cjs");

// ---- Kayıt defteri bütünlüğü ----

test("komut adlari benzersizdir ve hepsi aciklama tasir", () => {
  const adlar = SLASH_COMMANDS.map((c) => c.cmd);
  assert.equal(new Set(adlar).size, adlar.length, "yinelenen komut var");
  for (const c of SLASH_COMMANDS) {
    assert.ok(c.aciklama?.length > 8, `${c.cmd}: aciklama yetersiz`);
    assert.ok(["onek", "eylem"].includes(c.tur), `${c.cmd}: tur gecersiz`);
    assert.ok(c.grup, `${c.cmd}: grup yok`);
    if (c.tur === "eylem") assert.ok(c.eylem, `${c.cmd}: eylem adi yok`);
  }
});

test("yonlendirme kademeleri ve zengin komut seti mevcut", () => {
  const adlar = new Set(SLASH_COMMANDS.map((c) => c.cmd));
  for (const zorunlu of ["hizli", "ikili", "konsey", "kod", "tartisma", "bol", "incele",
    "claude", "codex", "antigravity", "ox", "yeni", "durdur", "terminal", "gerisar", "mcp"]) {
    assert.ok(adlar.has(zorunlu), `eksik komut: /${zorunlu}`);
  }
  assert.ok(SLASH_COMMANDS.length >= 30, `komut sayisi az: ${SLASH_COMMANDS.length}`);
});

// ---- Filtre (Turkce kucuk harf dahil) ----

test("filtre bastan eslesmeyi one alir ve Turkce harflerle calisir", () => {
  const k = filterSlashCommands("/ko");
  // Bastan eslesenler (konsey, kod, kontrol) kayit sirasiyla one gelir.
  assert.ok(["konsey", "kod", "kontrol"].includes(k[0].cmd), k[0].cmd);
  assert.ok(k.some((c) => c.cmd === "kod") && k.some((c) => c.cmd === "konsey"));
  assert.ok(filterSlashCommands("İ").length > 0, "buyuk noktali I kucultulemedi");
  assert.equal(filterSlashCommands("").length, SLASH_COMMANDS.length, "bos sorgu tum listeyi vermeli");
});

// ---- Ayristirma ----

test("gecerli komut ayristirilir, bilinmeyen komut normal mesajdir", () => {
  const p = parseSlashInput("/kod repairMemory için test ekle");
  assert.equal(p.command.cmd, "kod");
  assert.equal(p.command.approach, "council");
  assert.equal(p.command.mode, "code");
  assert.equal(p.rest, "repairMemory için test ekle");
  assert.equal(parseSlashInput("/olmayanbirsey selam"), null);
  assert.equal(parseSlashInput("normal mesaj / kesirli"), null);
  assert.equal(parseSlashInput("/hizli")?.rest, "");
});

test("sablonlu komutlar metni sarar", () => {
  const p = parseSlashInput("/incele src/store.js diff");
  assert.match(p.command.sablon, /BAĞIMSIZ/);
  const ozet = parseSlashInput("/ozetle");
  assert.equal(ozet.command.metinsiz, true, "/ozetle tek basina gonderilebilmeli");
});

// ---- Yonlendirme cozumu (kademeli acilim) ----

test("zorlanan kademe koordinatoru ve uye cagrisini ezer", () => {
  const r = resolveTurnRoute({ mode: "code", forced: "quick", requestedMemberId: "m-claude" });
  assert.equal(r.approach, "quick");
  assert.equal(r.member_id, "m-claude");
  const c = resolveTurnRoute({ mode: "auto", forced: "council", routed: { approach: "quick", mode: "code" } });
  assert.equal(c.approach, "council");
  assert.equal(c.mode, "code", "council modu koordinator onerisinden gelmeli");
});

// Kademeli acilimin ozu: kullanici kod modunu secmis olsa bile kucuk is tam
// konsey torenine girmez; koordinator quick/pair onerirse ona uyulur.
test("acik modda kucuk is konseye zorlanmaz", () => {
  const r = resolveTurnRoute({ mode: "code", routed: { approach: "quick", member_id: "m-codex", reason: "tek satirlik is" } });
  assert.equal(r.approach, "quick");
  assert.equal(r.member_id, "m-codex");
});

test("acik modda konsey secilirse kullanicinin modu korunur", () => {
  const r = resolveTurnRoute({ mode: "split", routed: { approach: "council", mode: "discussion" } });
  assert.equal(r.approach, "council");
  assert.equal(r.mode, "split", "koordinator baska mod onerse de kullanici modu kazanmali");
});

test("auto modda koordinator karari aynen gecer", () => {
  const r = resolveTurnRoute({ mode: "auto", routed: { approach: "pair", member_id: "a", reviewer_id: "b" } });
  assert.deepEqual([r.approach, r.member_id, r.reviewer_id], ["pair", "a", "b"]);
});

test("koordinator dusmusse acik mod konseyle devam eder", () => {
  const r = resolveTurnRoute({ mode: "code", routed: null });
  assert.equal(r.approach, "council");
  assert.equal(r.mode, "code");
});
