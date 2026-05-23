import type http from "node:http";
import { getUserConfig, setUserConfig } from "../blackboard/query-user-config.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { readJsonBody, requireBearer, sendJson } from "./_shared.ts";

export function handleBrowserUserConfigGetRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  userId: string,
) {
  if (!requireBearer(req, runtime.config.controlSurfaceToken)) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }
  const config = getUserConfig(runtime.blackboard, userId);
  return sendJson(res, 200, { config });
}

export async function handleBrowserUserConfigPutRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  userId: string,
) {
  if (!requireBearer(req, runtime.config.controlSurfaceToken)) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }
  const body = await readJsonBody<{ config: Record<string, string> }>(req);
  if (!body.config || typeof body.config !== "object") {
    return sendJson(res, 400, { ok: false, error: "Missing config object" });
  }

  const entries = Object.entries(body.config);
  if (entries.length > 100) {
    return sendJson(res, 400, { ok: false, error: "Too many keys (max 100)" });
  }
  for (const [k, v] of entries) {
    if (typeof k !== "string" || k.length === 0) {
      return sendJson(res, 400, { ok: false, error: "Keys must be non-empty strings" });
    }
    if (typeof v !== "string") {
      return sendJson(res, 400, { ok: false, error: `Value for key "${k}" must be a string` });
    }
  }

  setUserConfig(runtime.blackboard, userId, body.config);
  return sendJson(res, 200, { ok: true });
}
