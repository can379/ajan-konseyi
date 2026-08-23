import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createWorktree, hasHead, publishCurrentBranch, publishIntegration } from "../src/gitops.js";

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

test("ana uygulama güncel dalı sağlayıcı sandbox'ı olmadan yayınlar",async(t)=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),"ajan-publish-"));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const remote=path.join(base,"remote.git"),repo=path.join(base,"repo"),key=path.join(base,"deploy-key");
  execFileSync("git",["init","--bare",remote]);fs.mkdirSync(repo);fs.writeFileSync(key,"test");
  git(repo,"init","-b","main");git(repo,"remote","add","origin",remote);
  fs.writeFileSync(path.join(repo,"a.txt"),"ilk\n");git(repo,"add","a.txt");git(repo,"commit","-m","ilk");git(repo,"push","-u","origin","main");
  fs.writeFileSync(path.join(repo,"a.txt"),"son\n");git(repo,"commit","-am","son");
  const result=await publishCurrentBranch(repo,key);
  assert.equal(result.published,true);assert.equal(result.commits,1);
  assert.equal(git(remote,"rev-parse","--short","main"),result.commit);

  // Aynı tree ve aynı ebeveyn, farklı commit kimliği: gerçek depoda görülen
  // d8e01a9 / 21ae6a3 durumunun birebir küçük modeli.
  const tree=git(remote,"show","-s","--format=%T","main"),parent=git(remote,"show","-s","--format=%P","main");
  const duplicate=git(remote,"commit-tree",tree,"-p",parent,"-m","aynı içeriğin uzak kopyası");
  git(remote,"update-ref","refs/heads/main",duplicate);
  fs.writeFileSync(path.join(repo,"after-duplicate.txt"),"devam\n");git(repo,"add","after-duplicate.txt");git(repo,"commit","-m","eşdeğerden sonra");
  const rebased=await publishCurrentBranch(repo,key);
  assert.equal(rebased.published,true);assert.equal(rebased.integratedRemote,true);
  assert.equal(git(remote,"rev-parse","--short","main"),rebased.commit);

  const other=path.join(base,"other");execFileSync("git",["clone","-b","main",remote,other]);
  fs.writeFileSync(path.join(other,"remote.txt"),"uzak\n");git(other,"add","remote.txt");git(other,"commit","-m","uzak");git(other,"push","origin","main");
  fs.writeFileSync(path.join(repo,"local.txt"),"yerel\n");git(repo,"add","local.txt");git(repo,"commit","-m","yerel");
  const merged=await publishCurrentBranch(repo,key);
  assert.equal(merged.published,true);assert.equal(merged.integratedRemote,true);
  assert.equal(fs.readFileSync(path.join(repo,"remote.txt"),"utf8"),"uzak\n");
});

test("ajan worktree'si commit edilmemiş güncel dosyaları da devralır",async(t)=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),"ajan-snapshot-"));
  const repo=path.join(base,"repo"),runs=path.join(base,"runs");fs.mkdirSync(repo);fs.mkdirSync(runs);
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  git(repo,"init","-b","main");
  fs.writeFileSync(path.join(repo,"tracked.txt"),"eski\n");git(repo,"add","tracked.txt");git(repo,"commit","-m","ilk");
  fs.writeFileSync(path.join(repo,"tracked.txt"),"güncel\n");fs.writeFileSync(path.join(repo,"new.txt"),"yeni\n");
  const wt=await createWorktree(repo,runs,"run-snapshot","m-claude");
  assert.equal(fs.readFileSync(path.join(wt.wtDir,"tracked.txt"),"utf8"),"güncel\n");
  assert.equal(fs.readFileSync(path.join(wt.wtDir,"new.txt"),"utf8"),"yeni\n");
  assert.equal(fs.readFileSync(path.join(repo,"tracked.txt"),"utf8"),"güncel\n");
});

test("ilk commit'i olmayan Git projesi ana dalı değiştirmeden ajan worktree'sinde açılır",async(t)=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),"ajan-unborn-"));
  const repo=path.join(base,"repo"),runs=path.join(base,"runs");fs.mkdirSync(repo);fs.mkdirSync(runs);
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  git(repo,"init","-b","main");
  fs.writeFileSync(path.join(repo,"README.md"),"commitsiz proje\n");
  fs.writeFileSync(path.join(repo,"staged.txt"),"indexte\n");git(repo,"add","staged.txt");

  assert.equal(await hasHead(repo),false);
  const first=await createWorktree(repo,runs,"run-unborn","m-codex");
  const second=await createWorktree(repo,runs,"run-unborn","m-claude");
  assert.equal(fs.readFileSync(path.join(first.wtDir,"README.md"),"utf8"),"commitsiz proje\n");
  assert.equal(fs.readFileSync(path.join(first.wtDir,"staged.txt"),"utf8"),"indexte\n");
  assert.equal(fs.readFileSync(path.join(second.wtDir,"README.md"),"utf8"),"commitsiz proje\n");
  assert.equal(git(first.wtDir,"merge-base",first.branch,second.branch).length>0,true);
  assert.equal(await hasHead(repo),false);
  assert.match(git(repo,"status","--short","--branch"),/No commits yet on main/);
});
