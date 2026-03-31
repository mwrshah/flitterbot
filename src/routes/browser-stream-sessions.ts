import type http from "node:http";
import { getSessionsByStreamSessionId } from "../blackboard/query-sessions.ts";
import type { StreamSessionsListResponse } from "../contracts/index.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { sendJson } from "./_shared.ts";

export async function handleBrowserStreamSessionsRoute(
  runtime: ControlSurfaceRuntime,
  _request: http.IncomingMessage,
  response: http.ServerResponse,
  streamSessionId: string,
) {
  const body: StreamSessionsListResponse = {
    items: getSessionsByStreamSessionId(runtime.blackboard, streamSessionId),
  };
  return sendJson(response, 200, body);
}
