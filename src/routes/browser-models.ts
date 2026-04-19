import type http from "node:http";
import type { ModelListItem, ModelsListResponse } from "../contracts/index.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { sendJson } from "./_shared.ts";

/**
 * GET /api/models — return the configured model selector entries plus the
 * current `defaultModel` id. Consumed by the web client to hydrate the
 * composer's model dropdown.
 */
export function handleBrowserModelsRoute(
  runtime: ControlSurfaceRuntime,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  const models: ModelListItem[] = runtime.config.models.map((entry) => ({
    id: entry.id,
    label: entry.label,
    provider: entry.provider,
    modelId: entry.modelId,
    ...(entry.thinkingLevel ? { thinkingLevel: entry.thinkingLevel } : {}),
  }));
  const body: ModelsListResponse = {
    models,
    defaultModel: runtime.config.defaultModel,
  };
  return sendJson(res, 200, body);
}
