import type http from "node:http";
import type { ProviderAuthType } from "../contracts/index.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { readJsonBody, requireBearer, sendJson } from "./_shared.ts";

export async function handleAuthProvidersRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!authorized(runtime, req, res)) return;
  sendJson(res, 200, await runtime.providerAuth.listProviders());
}

export async function handleAuthLoginRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!authorized(runtime, req, res)) return;
  const body = await readJsonBody<{ providerId?: unknown; authType?: unknown }>(req);
  if (typeof body.providerId !== "string" || !body.providerId.trim()) {
    return sendJson(res, 400, { ok: false, error: "providerId (string) is required" });
  }
  if (!isProviderAuthType(body.authType)) {
    return sendJson(res, 400, { ok: false, error: "authType must be oauth or api_key" });
  }
  try {
    sendJson(
      res,
      202,
      await runtime.providerAuth.startLogin(body.providerId.trim(), body.authType),
    );
  } catch (error) {
    sendJson(res, 400, { ok: false, error: errorMessage(error) });
  }
}

export function handleAuthFlowRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  flowId: string,
): void {
  if (!authorized(runtime, req, res)) return;
  const flow = runtime.providerAuth.getFlow(flowId);
  if (!flow) return sendJson(res, 404, { ok: false, error: "Authentication flow not found" });
  sendJson(res, 200, flow);
}

export async function handleAuthFlowResponseRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  flowId: string,
): Promise<void> {
  if (!authorized(runtime, req, res)) return;
  const body = await readJsonBody<{ promptId?: unknown; value?: unknown }>(req);
  if (typeof body.promptId !== "string" || typeof body.value !== "string") {
    return sendJson(res, 400, {
      ok: false,
      error: "promptId and value must be strings",
    });
  }
  if (!runtime.providerAuth.getFlow(flowId)) {
    return sendJson(res, 404, { ok: false, error: "Authentication flow not found" });
  }
  try {
    sendJson(res, 200, runtime.providerAuth.respond(flowId, body.promptId, body.value));
  } catch (error) {
    sendJson(res, 409, { ok: false, error: errorMessage(error) });
  }
}

export function handleAuthFlowCancelRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  flowId: string,
): void {
  if (!authorized(runtime, req, res)) return;
  if (!runtime.providerAuth.getFlow(flowId)) {
    return sendJson(res, 404, { ok: false, error: "Authentication flow not found" });
  }
  sendJson(res, 200, runtime.providerAuth.cancel(flowId));
}

export async function handleAuthLogoutRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  providerId: string,
): Promise<void> {
  if (!authorized(runtime, req, res)) return;
  try {
    await runtime.providerAuth.logout(providerId);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: errorMessage(error) });
  }
}

function authorized(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  if (requireBearer(req, runtime.config.controlSurfaceToken)) return true;
  sendJson(res, 401, { ok: false, error: "unauthorized" });
  return false;
}

function isProviderAuthType(value: unknown): value is ProviderAuthType {
  return value === "oauth" || value === "api_key";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
