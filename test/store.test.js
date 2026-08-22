import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";

test("run durumu atomik yazılır ve yeniden yüklenebilir", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ajan-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  const run = store.createRun({ request: "test", mode: "discussion", agents: ["m1"] });
  store.addMessage(run, { from: "m1", content: "yanıt" });
  assert.equal(fs.existsSync(path.join(root, "runs", run.id, "state.json.tmp")), false);
  const restored = new Store(root).getRun(run.id);
  assert.equal(restored.messages[0].content, "yanıt");
});
