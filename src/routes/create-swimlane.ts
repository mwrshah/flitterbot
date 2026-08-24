import type http from "node:http";
import path from "node:path";
import type { CreateSwimlaneRequest } from "../contracts/control-surface-api.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { stripStreamNamePrefix } from "../streams/strip-name-prefix.ts";
import { readJsonBody, requireBearer, sendJson } from "./_shared.ts";

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

export async function handleCreateSwimlaneRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!requireBearer(req, runtime.config.controlSurfaceToken)) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }

  let parsed: unknown;
  try {
    parsed = await readJsonBody(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(res, 400, { ok: false, error: `invalid JSON body: ${message}` });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return sendJson(res, 400, { ok: false, error: "request body must be a JSON object" });
  }

  const body = parsed as Record<string, unknown>;
  const prepared = body.message !== undefined || body.sourcePiSessionId !== undefined;
  let input: CreateSwimlaneRequest;

  if (prepared) {
    const name = stripStreamNamePrefix(text(body.name));
    const cwd = text(body.cwd);
    const message = text(body.message);
    const sourcePiSessionId = text(body.sourcePiSessionId);
    if (!name || !cwd || !message || !sourcePiSessionId) {
      return sendJson(res, 400, {
        ok: false,
        error: "name, cwd, message, and sourcePiSessionId are required launch strings",
      });
    }
    if (!path.isAbsolute(cwd)) {
      return sendJson(res, 400, { ok: false, error: "cwd must be an absolute path" });
    }
    input = { name, cwd, message, sourcePiSessionId };
  } else {
    if (
      (body.name !== undefined && typeof body.name !== "string") ||
      (body.cwd !== undefined && typeof body.cwd !== "string")
    ) {
      return sendJson(res, 400, { ok: false, error: "name and cwd must be strings" });
    }
    input = {
      name: typeof body.name === "string" ? stripStreamNamePrefix(text(body.name)) : undefined,
      cwd: typeof body.cwd === "string" ? text(body.cwd) : undefined,
    };
  }

  try {
    return sendJson(res, 200, await runtime.createSwimlaneProgrammatic(input));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(res, 400, { ok: false, error: message });
  }
}
