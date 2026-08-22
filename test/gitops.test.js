import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { publishIntegration } from "../src/gitops.js";

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@local", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@local" },
  }).trim();
}

test("integration dalı yalnız temiz ve beklenen hedef dala yayınlanır", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ajan-gitops-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-b", "main");
  fs.writeFileSync(path.join(dir, "a.txt"), "ilk\n");
  git(dir, "add", "a.txt"); git(dir, "commit", "-m", "ilk");
  git(dir, "checkout", "-b", "ajan/run-test/integration");
  fs.writeFileSync(path.join(dir, "a.txt"), "son\n");
  git(dir, "commit", "-am", "son");
  git(dir, "checkout", "main");

  const result = await publishIntegration(dir, "run-test", "main");
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "son\n");

  fs.writeFileSync(path.join(dir, "kirli.txt"), "x");
  await assert.rejects(() => publishIntegration(dir, "run-test", "main"), /commit edilmemiş/);
});
