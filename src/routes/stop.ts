import type http from "node:http";
import type { StopResponse } from "../contracts/index.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { requireBearer, sendJson } from "./_shared.ts";

export function handleStopRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  if (!requireBearer(req, runtime.config.controlSurfaceToken)) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }
  const body: StopResponse = { ok: true, message: "Shutting down control surface" };
  sendJson(res, 200, body);
  setTimeout(() => {
    void runtime.stop("shutdown").finally(() => process.exit(0));
  }, 10);
}
