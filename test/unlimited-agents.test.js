import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Config } from "../src/config.js";
import { normalizePlan } from "../src/validation.js";

test("kullanıcı on ikiden fazla konsey üyesini kalıcı kaydedebilir", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ajan-config-unlimited-"));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const config = new Config(root);
  const members = Array.from({ length:40 }, (_, index) => ({
    id:`m-${index}`, name:`Ajan ${index + 1}`,
    provider:index % 2 ? "codex" : "claude", role:"auto", enabled:true,
  }));
  config.update({ members });
  assert.equal(config.data.members.length, 40);
  assert.equal(new Config(root).data.members.length, 40);
});

test("koordinatör otuzdan fazla bağımsız ajan işi planlayabilir", () => {
  const subtasks = Array.from({ length:75 }, (_, index) => ({
    id:`t${index + 1}`, title:`İş ${index + 1}`, member_id:"m-codex",
    prompt:`Bağımsız işi yap ${index + 1}`, depends_on:[], model_tier:"fast",
  }));
  const plan = normalizePlan({ mode:"split", subtasks, review_rounds:1 }, ["m-codex"]);
  assert.equal(plan.subtasks.length, 75);
});
