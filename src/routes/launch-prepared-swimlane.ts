import type http from "node:http";
import type { SwimlaneLaunchArgs } from "../contracts/index.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { readJsonBody, requireBearer, sendJson } from "./_shared.ts";

export function parsePreparedLaunch(body: Partial<SwimlaneLaunchArgs>): SwimlaneLaunchArgs {
  if (
    typeof body.suggestedName !== "string" ||
    !body.suggestedName.trim() ||
    typeof body.cwd !== "string" ||
    !body.cwd.trim() ||
    typeof body.initialMessage !== "string" ||
    !body.initialMessage.trim() ||
    (body.additionalContext !== undefined && typeof body.additionalContext !== "string")
  ) {
    throw new Error("suggestedName, cwd, and initialMessage are required launch strings");
  }
  return {
    suggestedName: body.suggestedName,
    cwd: body.cwd,
    initialMessage: body.initialMessage,
    ...(body.additionalContext ? { additionalContext: body.additionalContext } : {}),
  };
}

export async function handleLaunchPreparedSwimlaneRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sourcePiSessionId: string,
): Promise<void> {
  if (!requireBearer(req, runtime.config.controlSurfaceToken)) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }

  try {
    const body = await readJsonBody<Partial<SwimlaneLaunchArgs>>(req);
    const launch = parsePreparedLaunch(body);
    const result = await runtime.createSwimlaneProgrammatic({
      name: launch.suggestedName,
      cwd: launch.cwd,
      initialMessage: launch.initialMessage,
      additionalContext: launch.additionalContext,
      sourcePiSessionId,
    });
    return sendJson(res, 200, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(res, 400, { ok: false, error: message });
  }
}
