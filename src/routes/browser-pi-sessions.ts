import type http from "node:http";
import { getSessionsByPiSessionId } from "../blackboard/query-sessions.ts";
import type { PiSessionsListResponse } from "../contracts/index.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { sendJson } from "./_shared.ts";

export async function handleBrowserPiSessionsRoute(
  runtime: ControlSurfaceRuntime,
  _request: http.IncomingMessage,
  response: http.ServerResponse,
  piSessionId: string,
) {
  const body: PiSessionsListResponse = {
    items: getSessionsByPiSessionId(runtime.blackboard, piSessionId),
  };
  return sendJson(response, 200, body);
}
