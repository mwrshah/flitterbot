import { exec as cpExec } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import type { BlackboardDatabase } from "../blackboard/db.ts";
import { endPiSession } from "../blackboard/pi-sessions.ts";
import { markSessionEnded } from "../blackboard/query-sessions.ts";
import { closeStream, getStreamById } from "../blackboard/query-streams.ts";
import { killTmuxSession } from "../claude-sessions/tmux.ts";

const execPromise = promisify(cpExec);

type CloseStreamResult = {
  ok: boolean;
  streamId: string;
  message: string;
  conflicts?: string[];
  merged?: boolean;
  pushed?: boolean;
  needsConfirmation?: boolean;
  currentBranch?: string | null;
  resolvedBaseBranch?: string | null;
};

// ponytail: share this git exec helper with create-worktree and prefer execFile args for quoting.
async function exec(cmd: string, cwd: string, timeoutMs = 30_000): Promise<string> {
  const { stdout } = await execPromise(cmd, { cwd, timeout: timeoutMs });
  return stdout.trim();
}

async function inferBranchFromWorktree(worktreePath: string): Promise<string | null> {
  try {
    return (await exec("git branch --show-current", worktreePath, 5_000)) || null;
  } catch {
    return null;
  }
}

async function isBranchAncestorOf(
  repoPath: string,
  branch: string,
  target: string,
): Promise<boolean> {
  try {
    await execPromise(`git merge-base --is-ancestor ${branch} ${target}`, {
      cwd: repoPath,
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function getConflictedFiles(repoPath: string): Promise<string[]> {
  try {
    const output = await exec("git diff --name-only --diff-filter=U", repoPath, 5_000);
    return output ? output.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}

type CommitResult =
  | { hasChanges: false }
  | { hasChanges: true; ok: true }
  | { hasChanges: true; ok: false; message: string };

async function commitUncommittedChanges(
  worktreePath: string,
  commitMessage: string,
): Promise<CommitResult> {
  const status = await exec("git status --porcelain", worktreePath, 5_000);
  if (!status) return { hasChanges: false };
  try {
    await exec("git add -A", worktreePath);
    const escaped = commitMessage.replace(/'/g, "'\\''");
    await exec(`git commit -m '${escaped}'`, worktreePath);
    return { hasChanges: true, ok: true };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { hasChanges: true, ok: false, message: msg };
  }
}

type MergeResult =
  | { ok: true; mergedAt: string }
  | { ok: false; conflicts: string[]; message: string };

async function findWorktreeForBranch(repoPath: string, branch: string): Promise<string | null> {
  let output: string;
  try {
    output = await exec("git worktree list --porcelain", repoPath, 5_000);
  } catch {
    return null;
  }
  const target = `refs/heads/${branch}`;
  let currentPath: string | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ") && currentPath) {
      const ref = line.slice("branch ".length).trim();
      if (ref === target) return currentPath;
    } else if (line === "") {
      currentPath = null;
    }
  }
  return null;
}

async function mergeToTarget(
  repoPath: string,
  branch: string,
  targetBranch: string,
): Promise<MergeResult> {
  try {
    await exec("git fetch origin", repoPath);
  } catch {}

  if (await isBranchAncestorOf(repoPath, branch, targetBranch)) {
    return { ok: true, mergedAt: repoPath };
  }

  // Git refuses `git checkout main` in repoPath when another worktree already has it checked out, so merge there instead.
  const existingWorktree = await findWorktreeForBranch(repoPath, targetBranch);
  let mergeCwd: string;
  if (existingWorktree) {
    mergeCwd = existingWorktree;
  } else {
    try {
      await exec(`git checkout ${targetBranch}`, repoPath);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        conflicts: [],
        message: `Failed to checkout ${targetBranch}: ${msg}`,
      };
    }
    mergeCwd = repoPath;
  }

  try {
    await exec(`git pull origin ${targetBranch} --ff-only`, mergeCwd);
  } catch {}

  try {
    // git's default merge message — the model-authored commit_message goes to the in-flight auto-commit, not the merge commit.
    await exec(`git merge ${branch} --no-edit`, mergeCwd);
    return { ok: true, mergedAt: mergeCwd };
  } catch {
    const conflicts = await getConflictedFiles(mergeCwd);
    if (conflicts.length > 0) {
      try {
        await exec("git merge --abort", mergeCwd);
      } catch {}
      return {
        ok: false,
        conflicts,
        message: `Merge conflict in ${mergeCwd}: ${conflicts.length} file(s) conflicted: ${conflicts.join(", ")}`,
      };
    }
    try {
      await exec("git merge --abort", mergeCwd);
    } catch {}
    return { ok: false, conflicts: [], message: "Merge failed (non-conflict error)" };
  }
}

async function pushBranch(cwd: string, targetBranch: string): Promise<boolean> {
  try {
    await exec(`git push origin ${targetBranch}`, cwd);
    return true;
  } catch {
    return false;
  }
}

export async function executeCloseStream(
  blackboard: BlackboardDatabase,
  piSessionId: string,
  streamId: string,
  mode: "merge" | "noop",
  commitMessage: string,
  baseBranchOverride?: string,
): Promise<CloseStreamResult> {
  const stream = getStreamById(blackboard, streamId);
  if (!stream) {
    return { ok: false, streamId, message: `Stream ${streamId} not found` };
  }
  if (stream.status !== "open") {
    return { ok: false, streamId, message: `Stream ${streamId} is already closed` };
  }

  if (mode === "merge" && baseBranchOverride === undefined) {
    const currentBranch = stream.worktree_path
      ? await inferBranchFromWorktree(stream.worktree_path)
      : null;
    const resolvedBaseBranch = stream.base_branch ?? null;
    return {
      ok: false,
      streamId,
      needsConfirmation: true,
      currentBranch,
      resolvedBaseBranch,
      message: `Preview: would merge ${currentBranch ?? "(unknown)"} → ${resolvedBaseBranch ?? "(none recorded)"}. Confirm by calling close_stream again with explicit base_branch.`,
    };
  }

  const activeSessions = blackboard
    .prepare(
      `SELECT session_id, tmux_session
       FROM sessions
       WHERE stream_id = ?
         AND status IN ('working', 'idle')`,
    )
    .all(streamId) as { session_id: string; tmux_session: string | null }[];

  let sessionsKilled = 0;
  for (const session of activeSessions) {
    if (session.tmux_session) {
      await killTmuxSession(session.tmux_session);
    }
    markSessionEnded(blackboard, session.session_id, "stream_closed");
    sessionsKilled++;
  }

  let merged = false;
  let pushed = false;
  let resolvedTargetBranch: string | undefined;

  // Every precondition failure returns an explicit error — a silent skip would close the stream while no git work happened, invisibly to the user.
  if (mode === "merge") {
    const worktreePath = stream.worktree_path;
    const repoPath = stream.repo_path;

    if (!worktreePath || !repoPath) {
      return {
        ok: false,
        streamId,
        message:
          "Stream has no worktree_path/repo_path recorded. Cannot merge. Set the worktree path on the stream (use create_worktree with update_worktree_path for an existing worktree, or create one fresh) and try again, or call close_stream with mode:noop to close without merging.",
      };
    }
    if (!fs.existsSync(worktreePath)) {
      return {
        ok: false,
        streamId,
        message: `Worktree at ${worktreePath} no longer exists on disk. Restore the worktree (or repoint stream.worktree_path via create_worktree update_worktree_path) and try again, or call close_stream with mode:noop to close without merging.`,
      };
    }

    const branch = await inferBranchFromWorktree(worktreePath);
    if (!branch) {
      return {
        ok: false,
        streamId,
        message: `Could not determine current branch in worktree ${worktreePath} (detached HEAD or git failure). Restore the branch and try again, or call close_stream with mode:noop to close without merging.`,
      };
    }

    const targetBranch = baseBranchOverride ?? stream.base_branch ?? null;
    if (!targetBranch) {
      return {
        ok: false,
        streamId,
        message:
          "Stream has no base_branch recorded. Cannot merge. Set base_branch on the stream record, pass base_branch to close_stream, or call close_stream with mode:noop.",
      };
    }
    resolvedTargetBranch = targetBranch;
    const commitResult = await commitUncommittedChanges(worktreePath, commitMessage);
    if (commitResult.hasChanges && !commitResult.ok) {
      return {
        ok: false,
        streamId,
        message: `Failed to commit uncommitted changes in worktree. Commit manually before closing. (${commitResult.message})`,
      };
    }
    const mergeResult = await mergeToTarget(repoPath, branch, targetBranch);
    if (mergeResult.ok === false) {
      return {
        ok: false,
        streamId,
        message: `${mergeResult.message}. Resolve conflicts there, then call close_stream again.`,
        conflicts: mergeResult.conflicts,
      };
    }
    merged = true;

    pushed = await pushBranch(mergeResult.mergedAt, targetBranch);
  }

  closeStream(blackboard, streamId);
  endPiSession(blackboard, piSessionId, "ended", "stream_closed");

  const parts = [`Stream "${stream.name}" closed.`];
  if (sessionsKilled > 0) parts.push(`${sessionsKilled} active session(s) terminated.`);
  if (mode === "noop") parts.push("Git operations skipped (noop mode).");
  if (merged && resolvedTargetBranch) parts.push(`Branch merged to ${resolvedTargetBranch}.`);
  if (pushed) parts.push("Pushed to origin.");

  return {
    ok: true,
    streamId,
    message: parts.join(" "),
    merged,
    pushed,
  };
}
