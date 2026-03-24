import type http from "node:http";
import type {
  RuntimeWhatsAppStartResponse,
  RuntimeWhatsAppStopResponse,
} from "../contracts/index.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { requireBearer, sendJson } from "./_shared.ts";

export async function handleRuntimeWhatsAppRoute(
  runtime: ControlSurfaceRuntime,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  action: "start" | "stop",
) {
  if (!requireBearer(request, runtime.config.controlSurfaceToken)) {
    return sendJson(response, 401, { ok: false, error: "unauthorized" });
  }

  const result: RuntimeWhatsAppStartResponse | RuntimeWhatsAppStopResponse =
    action === "start" ? await runtime.startWhatsAppDaemon() : await runtime.stopWhatsAppDaemon();
  return sendJson(response, 200, result);
}
