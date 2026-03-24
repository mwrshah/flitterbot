import type http from "node:http";
import { getSessionById } from "../blackboard/query-sessions.ts";
import type { SessionTranscriptResponse } from "../contracts/index.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { sendJson } from "./_shared.ts";

export async function handleBrowserTranscriptRoute(
  runtime: ControlSurfaceRuntime,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  sessionId: string,
) {
  const session = getSessionById(runtime.blackboard, sessionId);
  if (!session) {
    return sendJson(response, 404, { ok: false, error: "session not found" });
  }

  if (!session.transcriptPath) {
    return sendJson(response, 404, { ok: false, error: "session has no transcript" });
  }

  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const cursor = url.searchParams.get("cursor") ?? "0";
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10) || 100;
  const page: SessionTranscriptResponse = await runtime.getTranscript(sessionId, cursor, limit);
  return sendJson(response, 200, page);
}
