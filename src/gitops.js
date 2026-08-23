import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import os from "node:os";

const run = promisify(execFile);

function runWithInput(bin, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { ...options, stdio:["pipe", "pipe", "pipe"] });
    let stdout="", stderr="";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr || `${bin} ${args.join(" ")} exit ${code}`)));
    child.stdin.end(input);
  });
}

// Worktree'ler yalnız HEAD'den başlatılırsa kullanıcının ana ağaçtaki güncel,
// henüz commit edilmemiş çalışması ajanlara görünmez. Ana ağaca dokunmadan
// izlenen diff'i ve ignore edilmeyen yeni dosyaları yeni worktree'ye yansıt.
export async function mirrorWorkingSnapshot(projectDir, wtDir) {
  const { stdout:diff } = await run("git", ["-C", projectDir, "diff", "--binary", "--no-ext-diff", "HEAD"], { maxBuffer:50*1024*1024 });
  if (diff) await runWithInput("git", ["-C", wtDir, "apply", "--binary", "--whitespace=nowarn", "-"], diff);
  const { stdout:untracked } = await run("git", ["-C", projectDir, "ls-files", "--others", "--exclude-standard", "-z"], { encoding:null, maxBuffer:20*1024*1024 });
  for (const relative of Buffer.from(untracked).toString("utf8").split("\0").filter(Boolean)) {
    const source=path.resolve(projectDir,relative), target=path.resolve(wtDir,relative);
    if(!target.startsWith(path.resolve(wtDir)+path.sep) || !fs.existsSync(source))continue;
    const stat=fs.lstatSync(source);fs.mkdirSync(path.dirname(target),{recursive:true});
    if(stat.isSymbolicLink()){fs.rmSync(target,{force:true});fs.symlinkSync(fs.readlinkSync(source),target);}
    else if(stat.isFile())fs.copyFileSync(source,target);
  }
}

// Kod modu için git yardımcıları: her ajan ayrı dal + ayrı worktree'de çalışır,
// böylece aynı dosyanın eşzamanlı değiştirilmesi engellenir.
export async function isGitRepo(dir) {
  try {
    await run("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

// Git olmayan projeyi (kullanıcı onayından sonra) depoya çevirir
export async function initRepo(projectDir) {
  await run("git", ["-C", projectDir, "init", "-b", "main"]);
  await run("git", ["-C", projectDir, "add", "-A"]);
  await run("git", ["-C", projectDir, "commit", "-m", "ajan: başlangıç anlık görüntüsü", "--no-verify", "--allow-empty"], {
    env: { ...process.env, GIT_AUTHOR_NAME: "ajan-konseyi", GIT_AUTHOR_EMAIL: "ajan@local", GIT_COMMITTER_NAME: "ajan-konseyi", GIT_COMMITTER_EMAIL: "ajan@local" },
  });
}

export async function createWorktree(projectDir, runsDir, runId, agentName) {
  const branch = `ajan/${runId}/${agentName}`;
  const wtDir = path.join(runsDir, runId, "worktrees", agentName);
  // Kesinti sonrası devam: worktree zaten varsa yeniden kullan
  if (fs.existsSync(path.join(wtDir, ".git"))) return { branch, wtDir };
  await run("git", ["-C", projectDir, "worktree", "add", wtDir, "-b", branch], {
    maxBuffer: 10 * 1024 * 1024,
  });
  await mirrorWorkingSnapshot(projectDir, wtDir);
  return { branch, wtDir };
}

// Geri alma: koşunun tüm worktree'lerini ve ajan/integration dallarını siler.
export async function rollbackRun(projectDir, runsDir, runId) {
  await removeWorktrees(projectDir, runsDir, runId);
  const { stdout } = await run("git", ["-C", projectDir, "for-each-ref", "--format=%(refname:short)", `refs/heads/ajan/${runId}/`]).catch(() => ({ stdout: "" }));
  const deleted = [];
  for (const branch of stdout.trim().split("\n").filter(Boolean)) {
    await run("git", ["-C", projectDir, "branch", "-D", branch]).catch(() => {});
    deleted.push(branch);
  }
  return deleted;
}

export async function collectDiff(wtDir) {
  // Yeni dosyalar da diff'te görünsün diye önce intent-to-add
  await run("git", ["-C", wtDir, "add", "-A", "-N"]).catch(() => {});
  const { stdout: status } = await run("git", ["-C", wtDir, "status", "--porcelain"], {
    maxBuffer: 10 * 1024 * 1024,
  });
  const { stdout: diff } = await run("git", ["-C", wtDir, "diff"], {
    maxBuffer: 50 * 1024 * 1024,
  });
  return { status: status.trim(), diff };
}

export async function commitAll(wtDir, message) {
  await run("git", ["-C", wtDir, "add", "-A"]);
  await run("git", ["-C", wtDir, "commit", "-m", message, "--no-verify"], {
    env: { ...process.env, GIT_AUTHOR_NAME: "ajan-konseyi", GIT_AUTHOR_EMAIL: "ajan@local", GIT_COMMITTER_NAME: "ajan-konseyi", GIT_COMMITTER_EMAIL: "ajan@local" },
  });
}

export async function createImmutableSnapshot(wtDir, message="ajan: review snapshot") {
  const indexFile=path.join(os.tmpdir(),`ajan-review-index-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const env={...process.env,GIT_INDEX_FILE:indexFile,GIT_AUTHOR_NAME:"ajan-konseyi",GIT_AUTHOR_EMAIL:"ajan@local",GIT_COMMITTER_NAME:"ajan-konseyi",GIT_COMMITTER_EMAIL:"ajan@local"};
  try {
    const {stdout:parent}=await run("git",["-C",wtDir,"rev-parse","HEAD"]);
    await run("git",["-C",wtDir,"read-tree","HEAD"],{env});
    await run("git",["-C",wtDir,"add","-A"],{env});
    const {stdout:tree}=await run("git",["-C",wtDir,"write-tree"],{env});
    const {stdout:commit}=await run("git",["-C",wtDir,"commit-tree",tree.trim(),"-p",parent.trim(),"-m",message],{env});
    const {stdout:diff}=await run("git",["-C",wtDir,"diff","--binary","--no-ext-diff",parent.trim(),commit.trim()],{maxBuffer:50*1024*1024});
    return {commit:commit.trim(),parentCommit:parent.trim(),tree:tree.trim(),diff};
  } finally { fs.rmSync(indexFile,{force:true}); }
}

export async function currentTree(dir){const {stdout}=await run("git",["-C",dir,"write-tree"]);return stdout.trim();}

// Birleştirme yalnızca kullanıcı onayından sonra çağrılır.
// Çakışma olursa merge iptal edilir ve çakışan dosyalar raporlanır.
export async function mergeBranch(projectDir, runsDir, runId, branch) {
  const intDir = path.join(runsDir, runId, "worktrees", "_integration");
  const intBranch = `ajan/${runId}/integration`;
  try {
    await run("git", ["-C", projectDir, "worktree", "add", intDir, "-b", intBranch]);
  } catch {
    // integration worktree zaten var
  }
  try {
    await run("git", ["-C", intDir, "merge", "--no-ff", branch, "-m", `ajan: ${branch} birleştirildi`], {
      env: { ...process.env, GIT_AUTHOR_NAME: "ajan-konseyi", GIT_AUTHOR_EMAIL: "ajan@local", GIT_COMMITTER_NAME: "ajan-konseyi", GIT_COMMITTER_EMAIL: "ajan@local" },
    });
    return { ok: true, conflicts: [] };
  } catch (err) {
    const { stdout } = await run("git", ["-C", intDir, "diff", "--name-only", "--diff-filter=U"]).catch(() => ({ stdout: "" }));
    await run("git", ["-C", intDir, "merge", "--abort"]).catch(() => {});
    return { ok: false, conflicts: stdout.trim().split("\n").filter(Boolean), error: String(err.message || err).slice(0, 500) };
  }
}

export async function removeWorktrees(projectDir, runsDir, runId) {
  const base = path.join(runsDir, runId, "worktrees");
  const { stdout } = await run("git", ["-C", projectDir, "worktree", "list", "--porcelain"]).catch(() => ({ stdout: "" }));
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ") && line.includes(base)) {
      const wt = line.slice("worktree ".length);
      await run("git", ["-C", projectDir, "worktree", "remove", "--force", wt]).catch(() => {});
    }
  }
}

// Projenin güncel commit kısaltması (üyeleri aynı sürüme sabitlemek için)
export async function currentCommit(projectDir) {
  try {
    const { stdout } = await run("git", ["-C", projectDir, "rev-parse", "--short", "HEAD"]);
    return stdout.trim();
  } catch {
    return "";
  }
}

export async function currentBranch(projectDir) {
  const { stdout } = await run("git", ["-C", projectDir, "branch", "--show-current"]);
  const branch = stdout.trim();
  if (!branch) throw new Error("Proje detached HEAD durumunda; hedef dal belirlenemedi");
  return branch;
}

export async function ensureClean(projectDir) {
  const { stdout } = await run("git", ["-C", projectDir, "status", "--porcelain"]);
  if (stdout.trim()) {
    throw new Error("Ana çalışma ağacında commit edilmemiş değişiklikler var; güvenli yayınlama için önce bunları commit edin veya kaldırın");
  }
}

// Test edilmiş integration dalını, kullanıcının koşu başındaki dalına uygular.
// Bu adım ayrı kullanıcı onayından sonra çağrılır ve kirli çalışma ağacında çalışmaz.
export async function publishIntegration(projectDir, runId, targetBranch) {
  const integrationBranch = `ajan/${runId}/integration`;
  await ensureClean(projectDir);
  const current = await currentBranch(projectDir);
  if (current !== targetBranch) {
    throw new Error(`Proje dalı değişti (beklenen: ${targetBranch}, mevcut: ${current}); otomatik yayınlama durduruldu`);
  }
  try {
    await run("git", ["-C", projectDir, "merge", "--ff-only", integrationBranch], {
      env: { ...process.env, GIT_AUTHOR_NAME: "ajan-konseyi", GIT_AUTHOR_EMAIL: "ajan@local", GIT_COMMITTER_NAME: "ajan-konseyi", GIT_COMMITTER_EMAIL: "ajan@local" },
    });
    return { ok: true, branch: targetBranch };
  } catch (err) {
    return { ok: false, branch: targetBranch, error: String(err.message || err).slice(0, 800) };
  }
}

function shellQuote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }

// Ajan sağlayıcısının sandbox/DNS durumundan bağımsız, ana uygulama sürecinde
// kayıtlı deploy key ile yalnız mevcut dalı fast-forward güvenliğiyle yayınlar.
export async function publishCurrentBranch(projectDir, deployKey, requestedBranch = "") {
  if (!projectDir || !(await isGitRepo(projectDir))) throw new Error("Yayınlanacak Git projesi seçili değil");
  if (!deployKey || !fs.existsSync(deployKey)) throw new Error("GitHub deploy key bulunamadı");
  const branch = await currentBranch(projectDir);
  if (requestedBranch && requestedBranch !== branch) throw new Error(`Yalnız açık dal yayınlanabilir (açık: ${branch}, istenen: ${requestedBranch})`);
  const env = { ...process.env, GIT_TERMINAL_PROMPT:"0", GIT_SSH_COMMAND:`ssh -i ${shellQuote(deployKey)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new` };
  await run("git", ["-C", projectDir, "fetch", "origin", branch], { env, timeout:120_000, maxBuffer:4*1024*1024 });
  let { stdout:counts } = await run("git", ["-C", projectDir, "rev-list", "--left-right", "--count", `origin/${branch}...${branch}`], { env });
  let [behind,ahead] = counts.trim().split(/\s+/).map(Number);
  let integratedRemote=false;
  if (behind > 0) {
    // Untracked çıktı/yedekler yayını engellemez; yalnız izlenen dosyalardaki
    // commit edilmemiş değişiklikler güvenli otomatik birleştirmeyi durdurur.
    try {
      await run("git",["-C",projectDir,"diff","--quiet"]);
      await run("git",["-C",projectDir,"diff","--cached","--quiet"]);
    } catch { throw new Error("GitHub'daki değişikliği birleştirmek için önce izlenen yerel dosyaları commit edin"); }
    const gitEnv={...env,GIT_AUTHOR_NAME:"ajan-konseyi",GIT_AUTHOR_EMAIL:"ajan@local",GIT_COMMITTER_NAME:"ajan-konseyi",GIT_COMMITTER_EMAIL:"ajan@local"};
    // Aynı tree'nin farklı commit kimliğiyle yeniden yayınlanması (ör. yerel
    // d8e01a9 / uzak 21ae6a3) sahte bir ayrışma üretir. Eşdeğer yerel commit'i
    // bulup yalnız onun devamındaki commitleri uzak eşdeğerin üzerine taşı.
    const {stdout:remoteTree}=await run("git",["-C",projectDir,"show","-s","--format=%T",`origin/${branch}`],{env});
    const {stdout:localTrees}=await run("git",["-C",projectDir,"log","--format=%H %T",branch],{env,maxBuffer:8*1024*1024});
    const equivalent=localTrees.split("\n").map((line)=>line.trim().split(/\s+/)).find(([,tree])=>tree===remoteTree.trim())?.[0];
    try {
      if(ahead>0&&equivalent)await run("git",["-C",projectDir,"rebase","--onto",`origin/${branch}`,equivalent,branch],{env:gitEnv,timeout:120_000,maxBuffer:8*1024*1024});
      else await run("git",["-C",projectDir,"merge",ahead>0?"--no-ff":"--ff-only","--no-edit",`origin/${branch}`],{env:gitEnv,timeout:120_000,maxBuffer:8*1024*1024});
    } catch(error) {
      await run("git",["-C",projectDir,"rebase","--abort"]).catch(()=>{});
      await run("git",["-C",projectDir,"merge","--abort"]).catch(()=>{});
      throw new Error(`GitHub değişikliği otomatik birleştirilemedi; çalışma ağacı geri alındı: ${String(error.message||error).slice(0,300)}`);
    }
    ({stdout:counts}=await run("git",["-C",projectDir,"rev-list","--left-right","--count",`origin/${branch}...${branch}`],{env}));
    [behind,ahead]=counts.trim().split(/\s+/).map(Number);
    integratedRemote=true;
  }
  const { stdout:commit } = await run("git", ["-C", projectDir, "rev-parse", "--short", "HEAD"]);
  if (ahead === 0) return { ok:true, published:false, upToDate:true, branch, commit:commit.trim() };
  await run("git", ["-C", projectDir, "push", "origin", `${branch}:${branch}`], { env, timeout:120_000, maxBuffer:8*1024*1024 });
  return { ok:true, published:true, branch, commit:commit.trim(), commits:ahead, integratedRemote };
}
