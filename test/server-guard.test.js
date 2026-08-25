import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { rotateIfNeeded, openServerLog, nextRespawnDelay, MAX_LOG_BYTES } = require("../desktop/serverGuard.cjs");

test("yeniden dogma gecikmesi artar ve 15 saniyede tavan yapar", () => {
  assert.equal(nextRespawnDelay(1), 1000, "ilk olumde neredeyse aninda");
  assert.equal(nextRespawnDelay(2), 2000);
  assert.equal(nextRespawnDelay(3), 4000);
  assert.equal(nextRespawnDelay(10), 15000, "cokme dongusu makineyi bogmamali");
  assert.equal(nextRespawnDelay(0), 1000, "sifir/negatif deneme guvenli");
});

test("gunluk dondurme yalniz sinir asilinca calisir ve eski nesli korur", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
  const file = path.join(dir, "server.log");
  fs.writeFileSync(file, "kucuk");
  assert.equal(rotateIfNeeded(file, 1024), false, "sinir altinda donmemeli");
  fs.writeFileSync(file, "x".repeat(2048));
  assert.equal(rotateIfNeeded(file, 1024), true);
  assert.ok(fs.existsSync(`${file}.old`), "onceki nesil .old olarak kalmali");
  assert.ok(!fs.existsSync(file), "yeni gunluk temiz baslamali");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("gunluk satirlari zaman damgasiyla diske yazilir", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
  const log = openServerLog(dir);
  log.line("sunucu öldü (exit=1 sinyal=-)");
  await new Promise((r) => log.stream.end(r));
  const content = fs.readFileSync(log.file, "utf8");
  assert.match(content, /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] sunucu öldü \(exit=1/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("masaustu kabuk bekciyi gercekten baglar", () => {
  const main = fs.readFileSync(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  assert.match(main, /require\("\.\/serverGuard\.cjs"\)/);
  assert.match(main, /child\.on\("exit"/, "cocuk olumu dinlenmeli");
  assert.match(main, /nextRespawnDelay\(respawnAttempts\)/, "artan gecikme kullanilmali");
  assert.match(main, /stdio: \["ignore", "pipe", "pipe"\]/, "gunluk icin borular acik olmali");
  assert.match(main, /setInterval[\s\S]{0,200}serverReady\(\)/, "periyodik saglik yoklamasi olmali");
  assert.match(main, /quittingApp = true/, "kasitli kapanis bekciyi susturmali");
  assert.equal(MAX_LOG_BYTES > 0, true);
});
