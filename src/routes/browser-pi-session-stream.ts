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
  const ws = getStreamForPiSession(runtime.blackboard, piSessionId);
  if (!ws) {
    return sendJson(response, 404, { ok: false, error: "No stream for this pi session" });
  }
  const piSession = runtime.blackboard.get<{ cwd: string }>(
    "SELECT cwd FROM pi_sessions WHERE pi_session_id = ?",
    piSessionId,
  );
  return sendJson(response, 200, {
    streamId: ws.id,
    name: ws.name,
    repoPath: ws.repo_path ?? null,
    worktreePath: ws.worktree_path ?? null,
    baseBranch: ws.base_branch ?? 'main',
    piSessionCwd: piSession?.cwd ?? null,
  });
}
