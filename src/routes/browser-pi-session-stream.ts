import { exec as cpExec } from "node:child_process";
import type http from "node:http";
import { promisify } from "node:util";
import { getStreamForPiSession } from "../blackboard/query-streams.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { relativizeProjectsPath } from "../streams/projects-path.ts";
import {
  readWorktreeConfig,
  resolveBootstrapConfigSource,
  resolveMainRepoPath,
} from "../streams/worktree-config.ts";
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
  const cwd = cwdAbsolute ? relativizeProjectsPath(cwdAbsolute, runtime.config.projectsDir) : null;
  const branch = ws?.worktree_path ? await resolveWorktreeBranch(ws.worktree_path) : null;
  const configSource = await resolveBootstrapConfigSource(cwdAbsolute, ws?.worktree_path);
  const repoPath =
    ws?.repo_path ??
    (await resolveMainRepoPath(ws?.worktree_path)) ??
    (await resolveMainRepoPath(cwdAbsolute)) ??
    null;
  const repo = repoPath ? relativizeProjectsPath(repoPath, runtime.config.projectsDir) : null;
  const config = configSource
    ? await readWorktreeConfig(configSource)
    : { copyPaths: [], postCreate: [], baseRef: null };
  return sendJson(response, 200, {
    streamId: ws?.id ?? null,
    name: ws?.name ?? null,
    repoPath,
    repo,
    worktreePath: ws?.worktree_path ?? null,
    branch,
    baseBranch: ws?.base_branch ?? null,
    cwd,
    cwdAbsolute,
    copyPaths: config.copyPaths,
    postCreate: config.postCreate,
    configuredBaseRef: config.baseRef,
  });
}
