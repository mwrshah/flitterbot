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
};

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

async function commitUncommittedChanges(worktreePath: string): Promise<CommitResult> {
  const status = await exec("git status --porcelain", worktreePath, 5_000);
  if (!status) return { hasChanges: false };
  try {
    await exec("git add -A", worktreePath);
    await exec(
      'git commit -m "chore: auto-commit uncommitted changes before stream close"',
      worktreePath,
    );
    return { hasChanges: true, ok: true };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { hasChanges: true, ok: false, message: msg };
  }
}

type MergeResult = { ok: true } | { ok: false; conflicts: string[]; message: string };

async function mergeToMain(
  repoPath: string,
  branch: string,
  commitMessage?: string,
): Promise<MergeResult> {
  // Fetch latest
  try {
    await exec("git fetch origin", repoPath);
  } catch {
    // Non-fatal — continue with local state
  }

  // Check if already merged
  if (await isBranchAncestorOf(repoPath, branch, "main")) {
    return { ok: true };
  }

  // Checkout main
  try {
    await exec("git checkout main", repoPath);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      conflicts: [],
      message: `Failed to checkout main: ${msg}`,
    };
  }

  // Pull latest main
  try {
    await exec("git pull origin main --ff-only", repoPath);
  } catch {
    // Non-fatal — continue with local main
  }

  // Attempt merge
  try {
    const mergeCmd = commitMessage
      ? `git merge ${branch} -m '${commitMessage.replace(/'/g, "'\\''")}'`
      : `git merge ${branch} --no-edit`;
    await exec(mergeCmd, repoPath);
    return { ok: true };
  } catch {
    // Check if it's a conflict or a different error
    const conflicts = await getConflictedFiles(repoPath);
    if (conflicts.length > 0) {
      // Abort the failed merge so the repo isn't left in a dirty state
      try {
        await exec("git merge --abort", repoPath);
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        conflicts,
        message: `Merge conflict: ${conflicts.length} file(s) conflicted: ${conflicts.join(", ")}`,
      };
    }
    // Non-conflict merge failure
    try {
      await exec("git merge --abort", repoPath);
    } catch {
      /* ignore */
    }
    return { ok: false, conflicts: [], message: "Merge failed (non-conflict error)" };
  }
}

async function pushMain(repoPath: string): Promise<boolean> {
  try {
    await exec("git push origin main", repoPath);
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
  mergeCommitMessage?: string,
): Promise<CloseStreamResult> {
  const stream = getStreamById(blackboard, streamId);
  if (!stream) {
    return { ok: false, streamId, message: `Stream ${streamId} not found` };
  }
  if (stream.status !== "open") {
    return { ok: false, streamId, message: `Stream ${streamId} is already closed` };
  }

  // Step 0: Kill active CC sessions belonging to this stream
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

  // Step 1: Merge branch to main (only in merge mode)
  if (mode === "merge") {
    const worktreePath = stream.worktree_path;
    const repoPath = stream.repo_path;

    if (worktreePath && fs.existsSync(worktreePath) && repoPath) {
      const branch = await inferBranchFromWorktree(worktreePath);

      if (branch) {
        const commitResult = await commitUncommittedChanges(worktreePath);
        if (commitResult.hasChanges && !commitResult.ok) {
          return {
            ok: false,
            streamId,
            message: `Failed to commit uncommitted changes in worktree. Commit manually before closing. (${commitResult.message})`,
          };
        }
        const mergeResult = await mergeToMain(repoPath, branch, mergeCommitMessage);
        if (mergeResult.ok === false) {
          // Return early — resolve conflicts and call again
          return {
            ok: false,
            streamId,
            message:
              mergeResult.message +
              ". Resolve conflicts in the main repo, then call close_stream again.",
            conflicts: mergeResult.conflicts,
          };
        }
        merged = true;

        // Push main after clean merge
        pushed = await pushMain(repoPath);
      }
    }
  }

  // Step 2: Close stream and end Pi session (worktree left on disk)
  closeStream(blackboard, streamId);
  endPiSession(blackboard, piSessionId, "ended", "stream_closed");

  const parts = [`Stream "${stream.name}" closed.`];
  if (sessionsKilled > 0) parts.push(`${sessionsKilled} active session(s) terminated.`);
  if (mode === "noop") parts.push("Git operations skipped (noop mode).");
  if (merged) parts.push("Branch merged to main.");
  if (pushed) parts.push("Pushed to origin.");

  return {
    ok: true,
    streamId,
    message: parts.join(" "),
    merged,
    pushed,
  };
}

