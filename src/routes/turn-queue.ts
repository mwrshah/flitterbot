import type http from "node:http";
import type { RemoveTurnQueueItemResponse } from "../contracts/index.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { requireBearer, sendJson } from "./_shared.ts";

export function handleRemoveTurnQueueItemRoute(
  runtime: ControlSurfaceRuntime,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  piSessionId: string,
  itemId: string,
) {
  if (!requireBearer(request, runtime.config.controlSurfaceToken)) {
    return sendJson(response, 401, { error: "unauthorized" });
  }

  const managed = runtime.sessionManager.getByPiSessionId(piSessionId);
  if (!managed) return sendJson(response, 404, { error: "Pi session not found" });

  const result = managed.queue.remove(itemId);
  const body: RemoveTurnQueueItemResponse = {
    removed: result.removed,
    accepting: result.accepting,
    ...result.snapshot,
  };
  return sendJson(response, 200, body);
}
