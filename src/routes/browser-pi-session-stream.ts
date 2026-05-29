import { exec as cpExec } from "node:child_process";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getStreamForPiSession } from "../blackboard/query-streams.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { sendJson } from "./_shared.ts";

const execPromise = promisify(cpExec);

async function resolveWorktreeBranch(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await execPromise("git rev-parse --abbrev-ref HEAD", {
      cwd: worktreePath,
      timeout: 5_000,
    });
    const branch = stdout.trim();
    if (!branch || branch === "HEAD") return null;
    return branch;
  } catch {
    return null;
  }
}

export async function handleBrowserPiSessionStreamRoute(
  runtime: ControlSurfaceRuntime,
  _request: http.IncomingMessage,
  response: http.ServerResponse,
  piSessionId: string,
) {
  const piSession = runtime.blackboard.get<{ cwd: string }>(
    "SELECT cwd FROM pi_sessions WHERE pi_session_id = ?",
    piSessionId,
  );
  const ws = getStreamForPiSession(runtime.blackboard, piSessionId);
  if (!piSession && !ws) {
    return sendJson(response, 404, { ok: false, error: "Unknown pi session" });
  }
  const cwdAbsolute = piSession?.cwd ?? null;
  const cwd = cwdAbsolute ? relativizeCwd(cwdAbsolute, runtime.config.projectsDir) : null;
  const branch = ws?.worktree_path ? await resolveWorktreeBranch(ws.worktree_path) : null;
  return sendJson(response, 200, {
    streamId: ws?.id ?? null,
    name: ws?.name ?? null,
    repoPath: ws?.repo_path ?? null,
    worktreePath: ws?.worktree_path ?? null,
    branch,
    baseBranch: ws?.base_branch ?? null,
    cwd,
    cwdAbsolute,
  });
}

function relativizeCwd(cwdAbsolute: string, projectsDir: string): string {
  const rel = path.relative(projectsDir, cwdAbsolute);
  if (!rel || rel.startsWith("..")) return homeify(cwdAbsolute);
  return `../${rel}`;
}

function homeify(absolute: string): string {
  const home = os.homedir();
  if (absolute === home) return "~";
  if (absolute.startsWith(`${home}/`)) return `~/${absolute.slice(home.length + 1)}`;
  return absolute;
}
