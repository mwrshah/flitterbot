import type http from "node:http";
import type {
  DirectSessionMessageRequest,
  DirectSessionMessageResponse,
} from "../../contracts/index.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { readJsonBody, requireBearer, sendJson } from "./_shared.ts";

export async function handleDirectSessionMessageRoute(
  runtime: ControlSurfaceRuntime,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  sessionId: string,
) {
  if (!requireBearer(request, runtime.config.controlSurfaceToken)) {
    return sendJson(response, 401, { ok: false, error: "unauthorized" });
  }

  const body = await readJsonBody<DirectSessionMessageRequest>(request);
  if (!body.text) {
    return sendJson(response, 400, { ok: false, error: "text is required" });
  }

  const result: DirectSessionMessageResponse = await runtime.directSessionMessage(
    sessionId,
    body.text,
  );
  return sendJson(response, result.ok ? 200 : 409, result);
}
