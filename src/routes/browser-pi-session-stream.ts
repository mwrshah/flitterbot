import type http from "node:http";
import { getStreamForPiSession } from "../blackboard/query-streams.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { sendJson } from "./_shared.ts";

export async function handleBrowserPiSessionStreamRoute(
  runtime: ControlSurfaceRuntime,
  _request: http.IncomingMessage,
  response: http.ServerResponse,
  piSessionId: string,
) {
  // cwd is sourced exclusively from pi_sessions.cwd — i.e. where
  // createAgentSession was invoked for this pi session. No fallback to
  // stream.worktree_path / repo_path: the agent's actual working directory
  // is the single source of truth.
  const piSession = runtime.blackboard.get<{ cwd: string }>(
    "SELECT cwd FROM pi_sessions WHERE pi_session_id = ?",
    piSessionId,
  );
  const ws = getStreamForPiSession(runtime.blackboard, piSessionId);
  if (!piSession && !ws) {
    return sendJson(response, 404, { ok: false, error: "Unknown pi session" });
  }
  const cwd = piSession?.cwd ?? null;
  return sendJson(response, 200, {
    streamId: ws?.id ?? null,
    name: ws?.name ?? null,
    repoPath: ws?.repo_path ?? null,
    worktreePath: ws?.worktree_path ?? null,
    baseBranch: ws?.base_branch ?? null,
    cwd,
  });
}
