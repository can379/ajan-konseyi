import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");

test("çalışan ajan süreleri saniye dakika ve saat olarak canlı gösterilir", () => {
  assert.match(app, /function formatElapsed\(/);
  assert.match(app, /total < 60/);
  assert.match(app, /minutes < 60/);
  assert.match(app, /data-elapsed-start/);
  assert.match(app, /setInterval\(updateElapsedTimers, 1000\)/);
});

test("canlı yanıt ve toplu çalışma göstergeleri başlangıç zamanını kullanır", () => {
  assert.match(app, /state\.agents\[a\]\?\.since \|\| s\.startedAt/);
  assert.match(app, /elapsedHTML\(agent\.since\)/);
  assert.match(app, /task-elapsed/);
});
