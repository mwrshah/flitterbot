import type http from "node:http";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { readJsonBody, requireBearer, sendJson } from "./_shared.ts";

type CreateStreamRequest = {
  name?: string;
  cwd?: string;
};

export async function handleCreateStreamRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!requireBearer(req, runtime.config.controlSurfaceToken)) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }

  let body: CreateStreamRequest;
  try {
    body = await readJsonBody<CreateStreamRequest>(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(res, 400, { ok: false, error: `invalid JSON body: ${message}` });
  }

  try {
    const result = await runtime.createStreamProgrammatic({
      name: typeof body.name === "string" ? body.name : undefined,
      cwd: typeof body.cwd === "string" ? body.cwd : undefined,
    });
    return sendJson(res, 200, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(res, 400, { ok: false, error: message });
  }
}
