import type http from "node:http";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { readJsonBody, requireBearer, sendJson } from "./_shared.ts";

type PruneBody = {
  piSessionId?: unknown;
  entryId?: unknown;
};

/**
 * POST /api/streams/prune
 * Body: { piSessionId: string, entryId: string }
 *
 * Prunes the pi session's conversation history from `entryId` onwards by
 * moving the SessionManager leaf backwards (see runtime.pruneStreamHistory).
 */
export async function handlePruneStreamHistoryRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!requireBearer(req, runtime.config.controlSurfaceToken)) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }

  let body: PruneBody;
  try {
    body = await readJsonBody<PruneBody>(req);
  } catch (err) {
    return sendJson(res, 400, {
      ok: false,
      error: err instanceof Error ? err.message : "Invalid JSON body",
    });
  }

  if (typeof body.piSessionId !== "string" || !body.piSessionId.trim()) {
    return sendJson(res, 400, { ok: false, error: "piSessionId required" });
  }
  if (typeof body.entryId !== "string" || !body.entryId.trim()) {
    return sendJson(res, 400, { ok: false, error: "entryId required" });
  }

  try {
    const result = await runtime.pruneStreamHistory(body.piSessionId, body.entryId);
    return sendJson(res, 200, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /not found/i.test(message) ? 404 : 400;
    return sendJson(res, status, { ok: false, error: message });
  }
}
