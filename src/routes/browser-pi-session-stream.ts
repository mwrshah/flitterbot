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
  // Two cases: (1) pi_session bound to a stream (stream_id set) — return full
  // stream metadata; (2) default agent with no stream (stream_id NULL) — return
  // nulls for stream fields but still surface piSessionCwd as effectiveCwd.
  // 404 only when the pi_session itself is unknown.
  const piSession = runtime.blackboard.get<{ cwd: string }>(
    "SELECT cwd FROM pi_sessions WHERE pi_session_id = ?",
    piSessionId,
  );
  const ws = getStreamForPiSession(runtime.blackboard, piSessionId);
  if (!piSession && !ws) {
    return sendJson(response, 404, { ok: false, error: "Unknown pi session" });
  }
  const piSessionCwd = piSession?.cwd ?? null;
  const worktreePath = ws?.worktree_path ?? null;
  const repoPath = ws?.repo_path ?? null;
  const effectiveCwd = piSessionCwd ?? worktreePath ?? repoPath;
  return sendJson(response, 200, {
    streamId: ws?.id ?? null,
    name: ws?.name ?? null,
    repoPath,
    worktreePath,
    baseBranch: ws?.base_branch ?? null,
    piSessionCwd,
    effectiveCwd,
  });
}
