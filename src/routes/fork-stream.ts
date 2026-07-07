import type http from "node:http";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { readJsonBody, requireBearer, sendJson } from "./_shared.ts";

type ForkBody = {
  piSessionId?: unknown;
  entryId?: unknown;
};

export async function handleForkStreamRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!requireBearer(req, runtime.config.controlSurfaceToken)) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }

  let body: ForkBody;
  try {
    body = await readJsonBody<ForkBody>(req);
  } catch (err) {
    return sendJson(res, 400, {
      ok: false,
      error: err instanceof Error ? err.message : "Invalid JSON body",
    });
  }

  if (typeof body.piSessionId !== "string" || !body.piSessionId.trim()) {
    return sendJson(res, 400, { ok: false, error: "piSessionId required" });
  }
  const entryId =
    typeof body.entryId === "string" && body.entryId.trim() ? body.entryId : undefined;

  try {
    const result = await runtime.forkStream(body.piSessionId, entryId);
    return sendJson(res, 200, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /not found/i.test(message) ? 404 : 400;
    return sendJson(res, status, { ok: false, error: message });
  }
}
