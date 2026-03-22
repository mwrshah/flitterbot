import type http from "node:http";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { sendJson } from "./_shared.ts";

export function handleBrowserSkillsRoute(
  runtime: ControlSurfaceRuntime,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  const defaultPi = runtime.sessionManager.getDefault();
  if (!defaultPi.session) {
    return sendJson(res, 503, { ok: false, error: "Pi session not ready" });
  }
  const { skills } = defaultPi.session.resourceLoader.getSkills();
  const items = skills.map((s: any) => ({
    name: s.name,
    description: s.description,
    disableModelInvocation: s.disableModelInvocation,
  }));
  return sendJson(res, 200, { items });
}
