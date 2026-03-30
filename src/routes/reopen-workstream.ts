import type http from "node:http";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { requireBearer, sendJson } from "./_shared.ts";

export async function handleReopenWorkstreamRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  workstreamId: string,
): Promise<void> {
  if (!requireBearer(req, runtime.config.controlSurfaceToken)) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }

  try {
    const result = await runtime.reopenWorkstream(workstreamId);
    return sendJson(res, 200, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(res, 400, { ok: false, error: message });
  }
}
