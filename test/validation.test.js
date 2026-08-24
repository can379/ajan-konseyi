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
    approach: "council", member_id: "m1", reviewer_id: null, mode: "discussion", reason: "",
  });
});

test("ikili inceleme (L2) üretici ve denetçiyi farklı üyelere ayırır", () => {
  const route = normalizeRoute({ approach: "pair", member_id: "m1", reviewer_id: "m2" }, ["m1", "m2"]);
  assert.equal(route.approach, "pair");
  assert.equal(route.member_id, "m1");
  assert.equal(route.reviewer_id, "m2");
});

test("denetçi verilmezse ikili inceleme başka üyeyi denetçi seçer", () => {
  const route = normalizeRoute({ approach: "pair", member_id: "m1" }, ["m1", "m2"]);
  assert.equal(route.reviewer_id, "m2");
});

test("üretici ile aynı üye denetçi olamaz; tek üye varsa L1'e düşer", () => {
  assert.equal(normalizeRoute({ approach: "pair", member_id: "m1", reviewer_id: "m1" }, ["m1", "m2"]).reviewer_id, "m2");
  const solo = normalizeRoute({ approach: "pair", member_id: "m1", reviewer_id: "m1" }, ["m1"]);
  assert.equal(solo.approach, "quick");
  assert.equal(solo.reviewer_id, null);
});

test("alt görevi olmayan plan reddedilir", () => {
  assert.throws(() => normalizePlan({ subtasks: [] }, ["m1"]), /hiç görev/);
});
