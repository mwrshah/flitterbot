import type http from "node:http";
import { getSessionsByStreamsSessionId } from "../blackboard/query-sessions.ts";
import type { StreamsSessionsListResponse } from "../contracts/index.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { sendJson } from "./_shared.ts";

export async function handleBrowserStreamsSessionsRoute(
  runtime: ControlSurfaceRuntime,
  _request: http.IncomingMessage,
  response: http.ServerResponse,
  streamsSessionId: string,
) {
  const body: StreamsSessionsListResponse = {
    items: getSessionsByStreamsSessionId(runtime.blackboard, streamsSessionId),
  };
  return sendJson(response, 200, body);
}
