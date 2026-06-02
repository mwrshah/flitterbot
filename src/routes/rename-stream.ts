import type http from "node:http";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { readJsonBody, requireBearer, sendJson } from "./_shared.ts";

export async function handleRenameStreamRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  streamId: string,
): Promise<void> {
  if (!requireBearer(req, runtime.config.controlSurfaceToken)) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }

  try {
    const body = await readJsonBody<{ name: unknown }>(req);
    if (typeof body.name !== "string" || !body.name.trim()) {
      return sendJson(res, 400, { ok: false, error: "name must be a non-empty string" });
    }
    return sendJson(res, 200, runtime.setStreamName(streamId, body.name));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(res, 400, { ok: false, error: message });
  }
}
