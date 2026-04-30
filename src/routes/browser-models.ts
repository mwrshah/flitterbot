import type http from "node:http";
import { getModel, getModels, getProviders } from "@mariozechner/pi-ai";
import type { ModelConfigEntry } from "../config/load-config.ts";
import { persistModelsToConfigFile } from "../config/persist-models.ts";
import type { ModelListItem, ModelsListResponse } from "../contracts/index.ts";
import { createPiAuthStorage } from "../pi-auth.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { readJsonBody, requireBearer, sendJson } from "./_shared.ts";

/**
 * GET /api/models — return the configured model selector entries plus the
 * full pi-mono model catalog so the web client can offer the complete list.
 *
 * Response shape:
 *   - `pinned`:        curated favorites from `config.models[]`
 *   - `all`:           every provider/model in the pi SDK catalog, each
 *                      annotated with an `available` flag derived from Pi's
 *                      canonical auth (API keys, OAuth subscription tokens,
 *                      or environment variables).
 *   - `defaultModel`:  id used when the web client sends no explicit override
 *
 * IDs in `all` use the composite `provider/modelId` format because pi-mono has
 * 142+ duplicate bare ids across providers (e.g. `claude-opus-4-7` in both
 * `anthropic` and `opencode`). `resolveModelEntry` on the server accepts
 * either form.
 */
export async function handleBrowserModelsRoute(
  runtime: ControlSurfaceRuntime,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  const availabilityByProvider = await resolveProviderAvailability(runtime);
  const pinned: ModelListItem[] = runtime.config.models.map((entry) => ({
    id: entry.id,
    label: entry.label,
    provider: entry.provider,
    modelId: entry.modelId,
    ...(entry.thinkingLevel ? { thinkingLevel: entry.thinkingLevel } : {}),
    available: (availabilityByProvider.get(entry.provider) ?? "none") !== "none",
    authKind: availabilityByProvider.get(entry.provider) ?? "none",
  }));

  const all: ModelListItem[] = [];
  for (const provider of getProviders()) {
    const authKind = availabilityByProvider.get(provider) ?? "none";
    for (const model of getModels(provider)) {
      all.push({
        id: `${provider}/${model.id}`,
        label: model.name,
        provider,
        modelId: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        available: authKind !== "none",
        authKind,
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

/**
 * POST /api/models/pin — toggle pinning for a given model id. Body:
 *   { id: "<curated id | provider/modelId>", pin: boolean }
 *
 * On `pin: true`, adds a `ModelConfigEntry` for the id to `config.models[]`
 * (creating it from the pi SDK catalog if the id is a composite), mutates
 * the in-memory runtime config, atomically rewrites `~/.flitterbot/config.json`,
 * and broadcasts a `resources_reloaded` WS event so every open tab refetches.
 *
 * On `pin: false`, removes the entry with matching id. Idempotent — no-ops
 * when the id is already absent.
 *
 * Returns the updated pinned list + defaultModel so callers can reconcile
 * without a separate GET.
 */
export async function handleBrowserModelsPinRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  if (!requireBearer(req, runtime.config.controlSurfaceToken)) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }
  const body = await readJsonBody<{ id: unknown; pin: unknown; label?: unknown }>(req);
  if (typeof body.id !== "string" || !body.id.trim()) {
    return sendJson(res, 400, { ok: false, error: "id (string) is required" });
  }
  if (typeof body.pin !== "boolean") {
    return sendJson(res, 400, { ok: false, error: "pin (boolean) is required" });
  }
  const id = body.id.trim();
  const userLabel = typeof body.label === "string" ? body.label.trim() : "";

  const current = runtime.config.models;
  let nextList: ModelConfigEntry[];

  if (body.pin) {
    if (current.some((m) => m.id === id)) {
      // Already pinned — idempotent success.
      return sendJson(res, 200, await okResponse(runtime));
    }
    const entry = buildEntryFromId(id, userLabel, current);
    if (!entry) {
      return sendJson(res, 400, {
        ok: false,
        error: `Cannot pin "${id}" — not a valid curated id or provider/modelId pair`,
      });
    }
    nextList = [...current, entry];
  } else {
    nextList = current.filter((m) => m.id !== id);
    if (nextList.length === current.length) {
      // Nothing to remove — idempotent success.
      return sendJson(res, 200, await okResponse(runtime));
    }
    if (nextList.length === 0) {
      return sendJson(res, 400, {
        ok: false,
        error: "Cannot unpin the last model — keep at least one pinned entry",
      });
    }
  }

  // If the current defaultModel is being unpinned AND the defaultModel was a
  // curated id (not a composite), switch to the first remaining pinned id so
  // config stays internally consistent.
  let nextDefault = runtime.config.defaultModel;
  if (!body.pin && runtime.config.defaultModel === id && !id.includes("/")) {
    nextDefault = nextList[0]!.id;
  }

  runtime.config.models = nextList;
  runtime.config.defaultModel = nextDefault;
  persistModelsToConfigFile({ models: nextList, defaultModel: nextDefault });
  runtime.log(
    `models: ${body.pin ? "pinned" : "unpinned"} id=${id}; total=${nextList.length}; default=${nextDefault}`,
  );

  return sendJson(res, 200, await okResponse(runtime));
}

/**
 * PUT /api/models/default — set `defaultModel` in config. Body: `{ id: string }`.
 * The id must match a currently-pinned entry OR be a composite `provider/modelId`
 * that resolves against the pi SDK catalog.
 */
export async function handleBrowserModelsDefaultRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  if (!requireBearer(req, runtime.config.controlSurfaceToken)) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }
  const body = await readJsonBody<{ id: unknown }>(req);
  if (typeof body.id !== "string" || !body.id.trim()) {
    return sendJson(res, 400, { ok: false, error: "id (string) is required" });
  }
  const id = body.id.trim();

  const isPinned = runtime.config.models.some((m) => m.id === id);
  const isComposite = id.includes("/") && Boolean(buildEntryFromId(id, "", runtime.config.models));
  if (!isPinned && !isComposite) {
    return sendJson(res, 400, {
      ok: false,
      error: `Cannot set defaultModel to "${id}" — not pinned and not a valid provider/modelId pair`,
    });
  }

  runtime.config.defaultModel = id;
  persistModelsToConfigFile({
    models: runtime.config.models,
    defaultModel: id,
  });
  runtime.log(`models: defaultModel set to ${id}`);

  return sendJson(res, 200, await okResponse(runtime));
}

async function okResponse(runtime: ControlSurfaceRuntime) {
  const availabilityByProvider = await resolveProviderAvailability(runtime);
  return {
    ok: true,
    pinned: runtime.config.models.map((m) => ({
      id: m.id,
      label: m.label,
      provider: m.provider,
      modelId: m.modelId,
      ...(m.thinkingLevel ? { thinkingLevel: m.thinkingLevel } : {}),
      available: (availabilityByProvider.get(m.provider) ?? "none") !== "none",
      authKind: availabilityByProvider.get(m.provider) ?? "none",
    })),
    defaultModel: runtime.config.defaultModel,
  };
}

async function resolveProviderAvailability(
  runtime: ControlSurfaceRuntime,
): Promise<Map<string, ModelListItem["authKind"]>> {
  const authStorage = createPiAuthStorage(runtime.config.controlSurfaceAgentDir);
  const providers = new Set([
    ...getProviders(),
    ...runtime.config.models.map((model) => model.provider),
  ]);
  const entries = await Promise.all(
    [...providers].map(async (provider) => {
      const apiKey = await authStorage.getApiKey(provider);
      const credential = authStorage.get(provider);
      const authKind: ModelListItem["authKind"] = apiKey
        ? credential?.type === "oauth"
          ? "subscription"
          : "api_key"
        : "none";
      return [provider, authKind] as const;
    }),
  );
  return new Map(entries);
}

/**
 * Build a `ModelConfigEntry` for the given id. The id can be:
 *
 *   - A curated id already in `existing` (copy-through — useful for re-pinning
 *     after an unpin, though that path is already idempotent above).
 *   - A composite `provider/modelId` — resolved against the pi SDK catalog
 *     and synthesized into a fresh `ModelConfigEntry`.
 *
 * Returns null when the id matches neither form.
 */
function buildEntryFromId(
  id: string,
  userLabel: string,
  existing: ModelConfigEntry[],
): ModelConfigEntry | null {
  const existingMatch = existing.find((m) => m.id === id);
  if (existingMatch) return existingMatch;

  const slashIdx = id.indexOf("/");
  if (slashIdx <= 0 || slashIdx === id.length - 1) return null;
  const provider = id.slice(0, slashIdx);
  const rawModelId = id.slice(slashIdx + 1);
  const model = getModel(
    provider as Parameters<typeof getModel>[0],
    rawModelId as Parameters<typeof getModel>[1],
  );
  if (!model) return null;

  return {
    id,
    label: userLabel || model.name,
    provider,
    modelId: rawModelId,
  };
}
