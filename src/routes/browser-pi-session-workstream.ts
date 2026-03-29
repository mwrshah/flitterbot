import type http from "node:http";
import { getWorkstreamForPiSession } from "../blackboard/query-workstreams.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { sendJson } from "./_shared.ts";

export async function handleBrowserPiSessionWorkstreamRoute(
  runtime: ControlSurfaceRuntime,
  _request: http.IncomingMessage,
  response: http.ServerResponse,
  piSessionId: string,
) {
  const ws = getWorkstreamForPiSession(runtime.blackboard, piSessionId);
  if (!ws) {
    return sendJson(response, 404, { ok: false, error: "No workstream for this pi session" });
  }
  return sendJson(response, 200, {
    workstreamId: ws.id,
    name: ws.name,
    repoPath: ws.repo_path ?? null,
    worktreePath: ws.worktree_path ?? null,
  });
}
