import type http from "node:http";
import type { ClaudeHookPayload, HookResponse, HookRouteEventName } from "../../contracts/index.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { readJsonBody, requireBearer, sendJson } from "./_shared.ts";

export async function handleHookRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  eventName: HookRouteEventName,
) {
  if (!requireBearer(req, runtime.config.controlSurfaceToken)) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }
  const payload = await readJsonBody<ClaudeHookPayload>(req);
  const sessionId = (payload as Record<string, unknown>).session_id ?? (payload as Record<string, unknown>).sessionId;
  runtime.log(`hook ${eventName}: received session_id=${sessionId ?? "none"}`);
  const result: HookResponse = runtime.handleHook(eventName, payload);
  runtime.log(`hook ${eventName}: response ${JSON.stringify(result)}`);
  return sendJson(res, 200, result);
}
