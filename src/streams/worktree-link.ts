import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { BlackboardDatabase } from "../blackboard/db.ts";
import type { StreamRow, StreamStatus } from "../contracts/index.ts";

type WorktreeLinkCheck = { ok: true; branch: string } | { ok: false; reason: string };

type WorktreeReconcileResult =
  | { cleared: false; reason: "missing_path" | "usable" }
  | { cleared: true; reason: string; previousPath: string };

function realpathIfExists(targetPath: string): string | null {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return null;
  }
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function parsePorcelainWorktreePaths(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

function isRegisteredWorktree(repoPath: string, worktreePath: string): boolean {
  const repoRealpath = realpathIfExists(repoPath);
  if (!repoRealpath) return false;

  const worktreeRealpath = realpathIfExists(worktreePath);
  if (!worktreeRealpath) return false;

  let output: string;
  try {
    output = git(["worktree", "list", "--porcelain"], repoRealpath);
  } catch {
    return false;
  }

  return parsePorcelainWorktreePaths(output).some((candidate) => {
    const candidateRealpath = realpathIfExists(candidate);
    return candidateRealpath === worktreeRealpath;
  });
}

export function shouldReconcileWorktreeOnRecovery(status: StreamStatus): boolean {
  // Recovery of an already-open stream is a lifecycle repair for the pi_session.
  // It must not mutate the stream's topology fields (repo_path/worktree_path).
  return status === "closed";
}

export function checkWorktreeLink(
  worktreePath: string,
  repoPath?: string | null,
): WorktreeLinkCheck {
  const worktreeRealpath = realpathIfExists(worktreePath);
  if (!worktreeRealpath) return { ok: false, reason: "path does not exist" };

  const gitEntry = path.join(worktreeRealpath, ".git");
  if (!fs.existsSync(gitEntry)) return { ok: false, reason: "path is not a git worktree" };

  let topLevel: string;
  let branch: string;
  try {
    topLevel = git(["rev-parse", "--show-toplevel"], worktreeRealpath);
    branch = git(["rev-parse", "--abbrev-ref", "HEAD"], worktreeRealpath);
  } catch {
    return { ok: false, reason: "git metadata is unreadable" };
  }

  const topLevelRealpath = realpathIfExists(topLevel);
  if (topLevelRealpath !== worktreeRealpath) {
    return { ok: false, reason: "path is not the git worktree root" };
  }
  if (!branch || branch === "HEAD") {
    return { ok: false, reason: "worktree is detached" };
  }

  if (repoPath && !isRegisteredWorktree(repoPath, worktreeRealpath)) {
    return { ok: false, reason: "worktree is not registered with repo_path" };
  }

  return { ok: true, branch };
}

export function clearWorktreePathIfStale(
  db: BlackboardDatabase,
  stream: Pick<StreamRow, "id" | "repo_path" | "worktree_path">,
): WorktreeReconcileResult {
  if (!stream.worktree_path) return { cleared: false, reason: "missing_path" };

  const check = checkWorktreeLink(stream.worktree_path, stream.repo_path);
  if (check.ok) return { cleared: false, reason: "usable" };

  db.prepare("UPDATE streams SET worktree_path = NULL WHERE id = ?").run(stream.id);
  return { cleared: true, reason: check.reason, previousPath: stream.worktree_path };
}
