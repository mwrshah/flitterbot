import { execSync } from "node:child_process";
import fs from "node:fs";
import type { BlackboardDatabase } from "../blackboard/db.ts";
import { endPiSession } from "../blackboard/pi-sessions.ts";
import { markSessionEnded } from "../blackboard/query-sessions.ts";
import { closeWorkstream, getWorkstreamById } from "../blackboard/query-workstreams.ts";
import { killTmuxSession } from "../claude-sessions/tmux.ts";

type CloseWorkstreamResult = {
  ok: boolean;
  workstreamId: string;
  message: string;
  conflicts?: string[];
  merged?: boolean;
  pushed?: boolean;
};

function exec(cmd: string, cwd: string, timeoutMs = 30_000): string {
  return execSync(cmd, { cwd, timeout: timeoutMs, stdio: "pipe" }).toString().trim();
}

function inferBranchFromWorktree(worktreePath: string): string | null {
  try {
    return exec("git branch --show-current", worktreePath, 5_000) || null;
  } catch {
    return null;
  }
}

function isBranchAncestorOf(repoPath: string, branch: string, target: string): boolean {
  try {
    execSync(`git merge-base --is-ancestor ${branch} ${target}`, {
      cwd: repoPath,
      timeout: 10_000,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

function getConflictedFiles(repoPath: string): string[] {
  try {
    const output = exec("git diff --name-only --diff-filter=U", repoPath, 5_000);
    return output ? output.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}

type MergeResult = { ok: true } | { ok: false; conflicts: string[]; message: string };

function mergeToMain(repoPath: string, branch: string): MergeResult {
  // Fetch latest
  try {
    exec("git fetch origin", repoPath);
  } catch {
    // Non-fatal — continue with local state
  }

  // Check if already merged
  if (isBranchAncestorOf(repoPath, branch, "main")) {
    return { ok: true };
  }

  // Checkout main
  try {
    exec("git checkout main", repoPath);
  } catch (error: unknown) {
    const msg =
      error instanceof Error
        ? error.message
        : String(error);
    return {
      ok: false,
      conflicts: [],
      message: `Failed to checkout main: ${msg}`,
    };
  }

  // Pull latest main
  try {
    exec("git pull origin main --ff-only", repoPath);
  } catch {
    // Non-fatal — continue with local main
  }

  // Attempt merge
  try {
    exec(`git merge ${branch} --no-edit`, repoPath);
    return { ok: true };
  } catch {
    // Check if it's a conflict or a different error
    const conflicts = getConflictedFiles(repoPath);
    if (conflicts.length > 0) {
      // Abort the failed merge so the repo isn't left in a dirty state
      try {
        exec("git merge --abort", repoPath);
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
      exec("git merge --abort", repoPath);
    } catch {
      /* ignore */
    }
    return { ok: false, conflicts: [], message: "Merge failed (non-conflict error)" };
  }
}

function pushMain(repoPath: string): boolean {
  try {
    exec("git push origin main", repoPath);
    return true;
  } catch {
    return false;
  }
}

export async function executeCloseWorkstream(
  blackboard: BlackboardDatabase,
  piSessionId: string,
  workstreamId: string,
): Promise<CloseWorkstreamResult> {
  const workstream = getWorkstreamById(blackboard, workstreamId);
  if (!workstream) {
    return { ok: false, workstreamId, message: `Workstream ${workstreamId} not found` };
  }
  if (workstream.status !== "open") {
    return { ok: false, workstreamId, message: `Workstream ${workstreamId} is already closed` };
  }

  // Step 0: Kill active CC sessions belonging to this workstream
  const activeSessions = blackboard
    .prepare(
      `SELECT session_id, tmux_session
       FROM sessions
       WHERE workstream_id = ?
         AND status IN ('working', 'idle')`,
    )
    .all(workstreamId) as { session_id: string; tmux_session: string | null }[];

  let sessionsKilled = 0;
  for (const session of activeSessions) {
    if (session.tmux_session) {
      await killTmuxSession(session.tmux_session);
    }
    markSessionEnded(blackboard, session.session_id, "workstream_closed");
    sessionsKilled++;
  }

  const worktreePath = workstream.worktree_path;
  const repoPath = workstream.repo_path;
  let branch: string | null = null;
  let merged = false;
  let pushed = false;

  // Step 1: Merge branch to main (if worktree exists)
  if (worktreePath && fs.existsSync(worktreePath) && repoPath) {
    branch = inferBranchFromWorktree(worktreePath);

    if (branch) {
      const mergeResult = mergeToMain(repoPath, branch);
      if (mergeResult.ok === false) {
        // Return early — Pi resolves conflicts and calls again
        return {
          ok: false,
          workstreamId,
          message:
            mergeResult.message +
            ". Resolve conflicts in the main repo, then call close_workstream again.",
          conflicts: mergeResult.conflicts,
        };
      }
      merged = true;

      // Push main after clean merge
      pushed = pushMain(repoPath);
    }
  }

  // Step 2: Close workstream and end Pi session (worktree left on disk)
  closeWorkstream(blackboard, workstreamId);
  endPiSession(blackboard, piSessionId, "ended", "workstream_closed");

  const parts = [`Workstream "${workstream.name}" closed.`];
  if (sessionsKilled > 0) parts.push(`${sessionsKilled} active session(s) terminated.`);
  if (merged) parts.push("Branch merged to main.");
  if (pushed) parts.push("Pushed to origin.");

  return {
    ok: true,
    workstreamId,
    message: parts.join(" "),
    merged,
    pushed,
  };
}

export function createCloseWorkstreamTool(blackboard: BlackboardDatabase, piSessionId: string) {
  return {
    name: "close_workstream",
    label: "Close Workstream",
    description:
      "Close the current workstream. Merges the branch into main, pushes, closes the workstream, and ends this orchestrator session. The worktree is left on disk. If there are merge conflicts, returns the conflict details — resolve them and call again. Only call when the human explicitly confirms the work is done.",
    parameters: {
      type: "object",
      properties: {
        workstream_id: { type: "string", description: "ID of the workstream to close" },
      },
      required: ["workstream_id"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, params: { workstream_id: string }) => {
      const result = await executeCloseWorkstream(blackboard, piSessionId, params.workstream_id);
      return {
        content: [{ type: "text", text: result.message }],
        details: result,
      };
    },
  };
}
