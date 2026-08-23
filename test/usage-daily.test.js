import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { usageDayKey, distributeRunUsage, summarizeCalendarMonth } from "../src/util.js";

test("usageDayKey Europe/Istanbul gece sınırını doğru uygular", () => {
  assert.equal(usageDayKey("2026-08-23T21:30:00.000Z"), "2026-08-24");
  assert.equal(usageDayKey("2026-08-23T20:30:00.000Z"), "2026-08-23");
  assert.equal(usageDayKey("geçersiz"), null);
});

test("takvim ayı toplamı kayan 30 günlük toplamdan bağımsız hesaplanır",()=>{
  const records=[{day:"2026-07-31",cost:90,tokens:900,calls:9},{day:"2026-08-01",cost:2,tokens:20,calls:1},{day:"2026-08-23",cost:3,tokens:30,calls:2}];
  assert.deepEqual(summarizeCalendarMonth(records,"2026-08-23T12:00:00+03:00"),{month:"2026-08",cost:5,tokens:50,calls:3});
});

test("Antigravity grafiği kesin günlük kayıtları ve eski kayıt geri dolumunu okur", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /run\.usageDaily\|\|\{\}/);
  assert.match(server, /message\.from===member\|\|message\.provider==="antigravity"/);
  assert.match(server, /records=distributeRunUsage\(total,exact,fallbackDays\)/);
  assert.match(server, /monthCost:calendarMonth\.cost/);
  assert.match(server, /scanAntigravityAccountUsage/);
  assert.match(server, /\.gemini","antigravity-cli","conversations/);
  assert.match(server, /estimatedHistory:estimated/);
  assert.doesNotMatch(server, /const day=new Date\(stamp\)\.toISOString\(\)\.slice\(0,10\)/);
});

test("Claude ve Codex günlük tarayıcıları korunur", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /async function scanClaudeAccountUsage\(\)/);
  assert.match(server, /async function scanCodexAccountUsage\(\)/);
  assert.match(server, /return finalizeAccountUsage\("claude"/);
  assert.match(server, /return finalizeAccountUsage\("codex"/);
});

test("geçiş koşusu: kesin günlük kayıt ile kümülatif toplam arasındaki fark kaybolmaz", () => {
  // Düzeltmeden ÖNCE 3 güne yayılmış Antigravity sohbeti (usageDaily yok),
  // düzeltmeden SONRA gelen tek bir yeni çağrı.
  const total = { input: 300000, cachedInput: 0, output: 60000, calls: 30 };
  const exact = [{ day: "2026-08-23", usage: { input: 1000, cachedInput: 0, output: 200, calls: 1 } }];
  const fallbackDays = ["2026-08-18", "2026-08-20", "2026-08-23"];

  const records = distributeRunUsage(total, exact, fallbackDays);
  const sum = (field) => records.reduce((acc, item) => acc + Number(item.usage[field] || 0), 0);

  // Eski davranış yalnız `exact` döndürüp 299.000 girdi tokenini düşürüyordu.
  assert.equal(sum("input"), total.input);
  assert.equal(sum("output"), total.output);
  assert.equal(sum("calls"), total.calls);
  assert.equal(new Set(records.map((r) => r.day)).size, 3);
});

test("tamamen kesin kayıtlı koşuda tarihsel dağıtım yapılmaz", () => {
  const total = { input: 30, cachedInput: 0, output: 10, calls: 2 };
  const exact = [
    { day: "2026-08-22", usage: { input: 10, cachedInput: 0, output: 4, calls: 1 } },
    { day: "2026-08-23", usage: { input: 20, cachedInput: 0, output: 6, calls: 1 } },
  ];
  const records = distributeRunUsage(total, exact, ["2026-08-01"]);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((r) => r.day), ["2026-08-22", "2026-08-23"]);
});

test("kesin kayıt yokken tarihsel toplam mesaj günlerine eşit dağıtılır", () => {
  const records = distributeRunUsage({ input: 90, output: 30, calls: 3 }, [], ["2026-08-01", "2026-08-02", "2026-08-03"]);
  assert.equal(records.length, 3);
  assert.equal(records[0].usage.input, 30);
  assert.equal(records.reduce((a, r) => a + r.usage.output, 0), 30);
});

test("mesaj günü hiç yoksa kayıp veri uydurulmaz", () => {
  assert.deepEqual(distributeRunUsage({ input: 5 }, [], []), []);
});
