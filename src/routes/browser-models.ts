import type http from "node:http";
import { getEnvApiKey, getModels, getProviders } from "@mariozechner/pi-ai";
import type { ModelListItem, ModelsListResponse } from "../contracts/index.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { sendJson } from "./_shared.ts";

/**
 * GET /api/models — return the configured model selector entries plus the
 * full pi-mono model catalog so the web client can offer the complete list.
 *
 * Response shape:
 *   - `pinned`:        curated favorites from `config.models[]`
 *   - `all`:           every provider/model in the pi SDK catalog, each
 *                      annotated with an `available` flag derived from
 *                      `getEnvApiKey(provider)` so the UI can badge entries
 *                      whose provider has no auth configured.
 *   - `defaultModel`:  id used when the web client sends no explicit override
 *
 * IDs in `all` use the composite `provider/modelId` format because pi-mono has
 * 142+ duplicate bare ids across providers (e.g. `claude-opus-4-7` in both
 * `anthropic` and `opencode`). `resolveModelEntry` on the server accepts
 * either form.
 */
export function handleBrowserModelsRoute(
  runtime: ControlSurfaceRuntime,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  const pinned: ModelListItem[] = runtime.config.models.map((entry) => ({
    id: entry.id,
    label: entry.label,
    provider: entry.provider,
    modelId: entry.modelId,
    ...(entry.thinkingLevel ? { thinkingLevel: entry.thinkingLevel } : {}),
    available: Boolean(getEnvApiKey(entry.provider)),
  }));

  // Cache auth availability per provider — getEnvApiKey() touches disk for some
  // providers (Vertex ADC) so we only want to call it once per provider.
  const availabilityByProvider = new Map<string, boolean>();
  const all: ModelListItem[] = [];
  for (const provider of getProviders()) {
    let available = availabilityByProvider.get(provider);
    if (available === undefined) {
      available = Boolean(getEnvApiKey(provider));
      availabilityByProvider.set(provider, available);
    }
    for (const model of getModels(provider)) {
      all.push({
        id: `${provider}/${model.id}`,
        label: model.name,
        provider,
        modelId: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        available,
      });
    }
  }

  const body: ModelsListResponse = {
    pinned,
    all,
    defaultModel: runtime.config.defaultModel,
  };
  return sendJson(res, 200, body);
}
