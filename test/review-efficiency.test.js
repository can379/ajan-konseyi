import test from "node:test";
import assert from "node:assert/strict";
import { selectTaskReviewers } from "../src/orchestrator.js";

const members = [
  { id: "author", provider: "codex", role: "auto" },
  { id: "peer", provider: "codex", role: "auto" },
  { id: "cross", provider: "claude", role: "auto" },
  { id: "audit", provider: "claude", role: "denetci" },
];

test("normal görev bütün konseye değil tek seçilmiş uzmana inceletilir", () => {
  const picked = selectTaskReviewers({ assignee: "author", tier: "balanced" }, members[0], members, 2);
  assert.deepEqual(picked.map((m) => m.id), ["audit"]);
});

test("yalnız güçlü ve yüksek inceleme düzeyli görev iki uzmana çıkar", () => {
  const picked = selectTaskReviewers({ assignee: "author", tier: "strong" }, members[0], members, 2);
  assert.equal(picked.length, 2);
  assert.ok(picked.every((m) => m.id !== "author"));
  assert.equal(picked[0].id, "audit");
});
