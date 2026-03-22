import type http from "node:http";
import type { StatusResponse } from "../../contracts/index.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { sendJson } from "./_shared.ts";

export function handleStatusRoute(
  runtime: ControlSurfaceRuntime,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  const body: StatusResponse = runtime.getStatus();
  return sendJson(res, 200, body);
}
