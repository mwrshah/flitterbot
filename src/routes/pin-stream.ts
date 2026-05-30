import type http from "node:http";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { readJsonBody, requireBearer, sendJson } from "./_shared.ts";

export async function handlePinStreamRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  streamId: string,
): Promise<void> {
  if (!requireBearer(req, runtime.config.controlSurfaceToken)) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }

  try {
    const body = await readJsonBody<{ pinned: unknown }>(req);
    if (typeof body.pinned !== "boolean") {
      return sendJson(res, 400, { ok: false, error: "pinned must be a boolean" });
    }
    return sendJson(res, 200, runtime.setStreamPinned(streamId, body.pinned));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(res, 400, { ok: false, error: message });
  }
}
