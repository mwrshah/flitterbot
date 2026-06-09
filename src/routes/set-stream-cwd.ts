import type http from "node:http";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { readJsonBody, requireBearer, sendJson } from "./_shared.ts";

type SetStreamCwdRequest = {
  cwd?: string;
};

export async function handleSetStreamCwdRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  streamId: string,
): Promise<void> {
  if (!requireBearer(req, runtime.config.controlSurfaceToken)) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }

  let body: SetStreamCwdRequest;
  try {
    body = await readJsonBody<SetStreamCwdRequest>(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(res, 400, { ok: false, error: `invalid JSON body: ${message}` });
  }

  if (typeof body.cwd !== "string") {
    return sendJson(res, 400, { ok: false, error: "cwd is required" });
  }

  try {
    const result = await runtime.setStreamCwd(streamId, body.cwd);
    return sendJson(res, 200, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(res, 400, { ok: false, error: message });
  }
}
