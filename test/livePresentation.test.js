import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("canlı ajan görünümü ham model çıktısı veya noktalı kutu göstermez",()=>{
  const ui=fs.readFileSync(new URL("../ui/app.js",import.meta.url),"utf8");
  const css=fs.readFileSync(new URL("../ui/style.css",import.meta.url),"utf8");
  assert.match(ui,/live-status-only/);
  assert.doesNotMatch(ui,/live-content">\$\{esc\(s\.text\)\}/);
  assert.doesNotMatch(css,/\.live-msg \.m-content \{[^}]*dashed/);
});
