import type http from "node:http";
import { getStreamForStreamsSession } from "../blackboard/query-streams.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { sendJson } from "./_shared.ts";

export async function handleBrowserStreamsSessionStreamRoute(
  runtime: ControlSurfaceRuntime,
  _request: http.IncomingMessage,
  response: http.ServerResponse,
  streamsSessionId: string,
) {
  const ws = getStreamForStreamsSession(runtime.blackboard, streamsSessionId);
  if (!ws) {
    return sendJson(response, 404, { ok: false, error: "No stream for this pi session" });
  }
  return sendJson(response, 200, {
    streamId: ws.id,
    name: ws.name,
    repoPath: ws.repo_path ?? null,
    worktreePath: ws.worktree_path ?? null,
  });
}
