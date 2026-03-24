import type http from "node:http";
import type { ClaudeHookPayload, HookResponse, HookRouteEventName } from "../contracts/index.ts";
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
  const sessionId = payload.session_id ?? payload.sessionId;
  const result: HookResponse = runtime.handleHook(eventName, payload as Record<string, unknown>);
  // Single summary log — only include response detail for non-ok results
  const parts = [`hook ${eventName}: session_id=${sessionId ?? "none"}`];
  if (result.bookkeeping) parts.push("bookkeeping=true");
  if (result.filtered) parts.push("filtered=true");
  if (!result.ok) parts.push(`response=${JSON.stringify(result)}`);
  runtime.log(parts.join(" "));
  return sendJson(res, 200, result);
}
