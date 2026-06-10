import type http from "node:http";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { readJsonBody, requireBearer, sendJson } from "./_shared.ts";

type CompactBody = {
  piSessionId?: unknown;
  customInstructions?: unknown;
};

export async function handleCompactPiSessionRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!requireBearer(req, runtime.config.controlSurfaceToken)) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }

  let body: CompactBody;
  try {
    body = await readJsonBody<CompactBody>(req);
  } catch (err) {
    return sendJson(res, 400, {
      ok: false,
      error: err instanceof Error ? err.message : "Invalid JSON body",
    });
  }

  if (typeof body.piSessionId !== "string" || !body.piSessionId.trim()) {
    return sendJson(res, 400, { ok: false, error: "piSessionId required" });
  }
  if (body.customInstructions !== undefined && typeof body.customInstructions !== "string") {
    return sendJson(res, 400, { ok: false, error: "customInstructions must be a string" });
  }

  try {
    const result = await runtime.compactPiSession(
      body.piSessionId,
      body.customInstructions?.trim() || undefined,
    );
    return sendJson(res, 200, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /not found/i.test(message) ? 404 : 400;
    return sendJson(res, status, { ok: false, error: message });
  }
}
