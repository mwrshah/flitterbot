import type http from "node:http";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { readJsonBody, requireBearer, sendJson } from "./_shared.ts";
import { buildModelsMutationResponse } from "./browser-models.ts";

export async function handlePiSessionModelRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  piSessionId: string,
) {
  if (!requireBearer(req, runtime.config.controlSurfaceToken)) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }

  const body = await readJsonBody<{ id: unknown }>(req);
  if (typeof body.id !== "string" || !body.id.trim()) {
    return sendJson(res, 400, { ok: false, error: "id (string) is required" });
  }

  try {
    await runtime.setPiSessionModel(piSessionId, body.id.trim());
    return sendJson(res, 200, await buildModelsMutationResponse(runtime));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /not found/i.test(message) ? 404 : 400;
    return sendJson(res, status, { ok: false, error: message });
  }
}
