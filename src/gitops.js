import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

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

export async function createWorktree(projectDir, runsDir, runId, agentName) {
  const branch = `ajan/${runId}/${agentName}`;
  const wtDir = path.join(runsDir, runId, "worktrees", agentName);
  // Kesinti sonrası devam: worktree zaten varsa yeniden kullan
  if (fs.existsSync(path.join(wtDir, ".git"))) return { branch, wtDir };
  await run("git", ["-C", projectDir, "worktree", "add", wtDir, "-b", branch], {
    maxBuffer: 10 * 1024 * 1024,
  });
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
