import test from "node:test";
import assert from "node:assert/strict";
import { completeMergeOrder, normalizePlan, normalizeRoute } from "../src/validation.js";

test("merge sırası eksik üyeleri kaybetmez ve tekrarları kaldırır", () => {
  assert.deepEqual(completeMergeOrder(["m2", "m2", "bilinmeyen"], ["m1", "m2", "m3"]), ["m2", "m1", "m3"]);
});

test("plan görevlerini ve bağımlılıklarını güvenli biçimde normalleştirir", () => {
  const plan = normalizePlan({ mode: "code", subtasks: [
    { id: "t1", title: "A", member_id: "m1", prompt: "yap", depends_on: ["yok"] },
    { id: "t1", title: "B", member_id: "yok", depends_on: ["t1"] },
  ] }, ["m1", "m2"]);
  assert.equal(plan.subtasks.length, 2);
  assert.equal(plan.subtasks[1].id, "t2");
  assert.equal(plan.subtasks[1].member_id, "m1");
  assert.deepEqual(plan.subtasks[0].depends_on, []);
});

test("bozuk yönlendirme güvenli council varsayılanına döner", () => {
  assert.deepEqual(normalizeRoute({}, ["m1"]), {
    approach: "council", member_id: "m1", mode: "discussion", reason: "",
  });
});

test("alt görevi olmayan plan reddedilir", () => {
  assert.throws(() => normalizePlan({ subtasks: [] }, ["m1"]), /hiç görev/);
});
