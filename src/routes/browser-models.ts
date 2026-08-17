import type http from "node:http";
import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ModelConfigEntry } from "../config/load-config.ts";
import { persistModelsToConfigFile } from "../config/persist-models.ts";
import type {
  ModelListItem,
  ModelsListResponse,
  ModelsMutationResponse,
} from "../contracts/index.ts";
import { createPiModelRegistry } from "../pi-auth.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { readJsonBody, requireBearer, sendJson } from "./_shared.ts";

export async function handleBrowserModelsRoute(
  runtime: ControlSurfaceRuntime,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  return sendJson(res, 200, await buildModelsListResponse(runtime));
}

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

  const config = runtime.config;
  const current = config.models;
  let nextList: ModelConfigEntry[];

  if (body.pin) {
    if (current.some((m) => m.id === id)) {
      return sendJson(res, 200, await buildModelsMutationResponse(runtime));
    }
    const entry = buildEntryFromId(id, userLabel, current, await getModelRegistry(runtime));
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
      return sendJson(res, 200, await buildModelsMutationResponse(runtime));
    }
    if (nextList.length === 0) {
      return sendJson(res, 400, {
        ok: false,
        error: "Cannot unpin the last model — keep at least one pinned entry",
      });
    }
  }

  let nextDefault = config.defaultModel;
  if (!body.pin && config.defaultModel === id && !id.includes("/")) {
    nextDefault = nextList[0]!.id;
  }

  persistModelsToConfigFile({ models: nextList, defaultModel: nextDefault });
  runtime.log(
    `models: ${body.pin ? "pinned" : "unpinned"} id=${id}; total=${nextList.length}; default=${nextDefault}`,
  );

  return sendJson(res, 200, await buildModelsMutationResponse(runtime));
}

export async function buildModelsListResponse(
  runtime: ControlSurfaceRuntime,
): Promise<ModelsListResponse> {
  const registry = await getModelRegistry(runtime);
  const config = runtime.config;
  const pinned = config.models.map((entry) => buildPinnedModelItem(entry, registry));
  const pinnedCatalogKeys = new Set(pinned.map((entry) => `${entry.provider}/${entry.modelId}`));
  const catalog = registry.getAll();
  const catalogItems = catalog.map((model) => buildCatalogModelItem(model, registry));
  const catalogItemsById = new Map(catalogItems.map((model) => [model.id, model]));
  const initialCatalogItems = selectInitialCatalogModels(catalog).flatMap((model) => {
    const id = `${model.provider}/${model.id}`;
    const item = catalogItemsById.get(id);
    return item && !pinnedCatalogKeys.has(id) ? [item] : [];
  });
  const initialModelIds = [...pinned, ...initialCatalogItems]
    .sort(compareModelAvailability)
    .map((model) => model.id);

  return {
    pinned,
    all: catalogItems.filter((model) => !pinnedCatalogKeys.has(model.id)),
    initialModelIds,
    defaultModel: config.defaultModel,
    defaultThinkingLevel: config.defaultThinkingLevel,
  };
}

export async function buildModelsMutationResponse(
  runtime: ControlSurfaceRuntime,
): Promise<ModelsMutationResponse> {
  return {
    ok: true,
    ...(await buildModelsListResponse(runtime)),
  };
}

async function getModelRegistry(runtime: ControlSurfaceRuntime): Promise<ModelRegistry> {
  return createPiModelRegistry(await runtime.resolveModelRuntime());
}

const INITIAL_PROVIDER_ORDER = [
  "openai-codex",
  "openai",
  "anthropic",
  "fireworks",
  "groq",
  "github-copilot",
  "opencode",
] as const;
const INITIAL_PROVIDER_RANK = new Map<string, number>(
  INITIAL_PROVIDER_ORDER.map((provider, index) => [provider, index]),
);
const INITIAL_ALL_MODEL_PROVIDERS = new Set(["openai-codex", "fireworks", "groq"]);
const OPENAI_EXCLUDED_MODELS = new Set([
  "gpt-4",
  "gpt-4-turbo",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4o-2024-05-13",
  "gpt-4o-2024-08-06",
  "gpt-4o-2024-11-20",
  "gpt-5",
  "gpt-5-chat-latest",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-5-pro",
  "gpt-5.1",
  "gpt-5.2",
  "gpt-5.2-chat-latest",
  "gpt-5.2-pro",
  "gpt-5.3-chat-latest",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.4-pro",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-realtime-2.1",
  "o1",
  "o1-pro",
  "o3",
  "o3-mini",
  "o3-pro",
  "o4-mini",
]);
const ANTHROPIC_EXCLUDED_MODELS = new Set([
  "claude-haiku-4-5-20251001",
  "claude-opus-4-1",
  "claude-opus-4-1-20250805",
  "claude-opus-4-5",
  "claude-opus-4-5-20251101",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
]);
const COPILOT_INITIAL_MODELS = new Set([
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-opus-4.8",
  "claude-fable-5",
  "kimi-k2.7-code",
]);
const OPENCODE_INITIAL_MODELS = new Set([
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-fable-5",
  "glm-5.2",
  "deepseek-v4-flash",
  "deepseek-v4-flash-free",
  "deepseek-v4-pro",
  "kimi-k2.5",
  "kimi-k2.6",
  "kimi-k2.7-code",
]);

type CatalogModel = Pick<Model<Api>, "id" | "name" | "provider">;

function selectInitialCatalogModels<T extends CatalogModel>(models: T[]): T[] {
  return models.filter(isInitialCatalogModel).sort(compareInitialCatalogModels);
}

function isInitialCatalogModel(model: CatalogModel): boolean {
  if (INITIAL_ALL_MODEL_PROVIDERS.has(model.provider)) return true;
  if (model.provider === "openai") return !OPENAI_EXCLUDED_MODELS.has(model.id);
  if (model.provider === "anthropic") return !ANTHROPIC_EXCLUDED_MODELS.has(model.id);
  if (model.provider === "github-copilot") return COPILOT_INITIAL_MODELS.has(model.id);
  if (model.provider === "opencode") return OPENCODE_INITIAL_MODELS.has(model.id);
  return false;
}

function compareInitialCatalogModels(a: CatalogModel, b: CatalogModel): number {
  const provider =
    (INITIAL_PROVIDER_RANK.get(a.provider) ?? Number.MAX_SAFE_INTEGER) -
    (INITIAL_PROVIDER_RANK.get(b.provider) ?? Number.MAX_SAFE_INTEGER);
  if (provider !== 0) return provider;
  const version = compareModelVersionDesc(a, b);
  if (version !== 0) return version;
  return a.name.localeCompare(b.name);
}

function compareModelAvailability(a: ModelListItem, b: ModelListItem): number {
  return Number(b.authKind !== "none") - Number(a.authKind !== "none");
}

function compareModelVersionDesc(a: CatalogModel, b: CatalogModel): number {
  const aVersion = extractVersionParts(a);
  const bVersion = extractVersionParts(b);
  if (aVersion.length === 0 || bVersion.length === 0) return 0;
  const length = Math.max(aVersion.length, bVersion.length);
  for (let index = 0; index < length; index++) {
    const difference = (bVersion[index] ?? 0) - (aVersion[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function extractVersionParts(model: CatalogModel): number[] {
  const match =
    /(?:gpt|claude|gemini|glm|llama|qwen|mistral|deepseek|kimi)[-\s]?([0-9]+(?:[.p-][0-9]+)*)/i.exec(
      `${model.id} ${model.name}`,
    );
  if (!match?.[1]) return [];
  return match[1].split(/[.p-]/).map((part) => Number(part));
}

function buildCatalogModelItem(model: Model<Api>, registry: ModelRegistry): ModelListItem {
  const authKind = resolveAuthKind(registry, model);
  return {
    id: `${model.provider}/${model.id}`,
    label: model.name,
    provider: model.provider,
    modelId: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    ...modelThinkingCapabilities(model),
    authKind,
  };
}

function buildPinnedModelItem(entry: ModelConfigEntry, registry: ModelRegistry): ModelListItem {
  const catalogModel = registry.find(entry.provider, entry.modelId);
  const authKind = catalogModel ? resolveAuthKind(registry, catalogModel) : "none";
  return {
    id: entry.id,
    label: entry.label,
    provider: entry.provider,
    modelId: entry.modelId,
    ...(entry.thinkingLevel ? { thinkingLevel: entry.thinkingLevel } : {}),
    ...(catalogModel ? modelThinkingCapabilities(catalogModel) : {}),
    authKind,
  };
}

function resolveAuthKind(registry: ModelRegistry, model: Model<Api>): ModelListItem["authKind"] {
  if (!registry.hasConfiguredAuth(model)) return "none";
  return registry.isUsingOAuth(model) ? "subscription" : "api_key";
}

function modelThinkingCapabilities(model: Model<Api>) {
  return {
    reasoning: Boolean(model.reasoning),
    supportsXhigh: getSupportedThinkingLevels(model).includes("xhigh"),
    supportsMax: getSupportedThinkingLevels(model).includes("max"),
  };
}

function buildEntryFromId(
  id: string,
  userLabel: string,
  existing: ModelConfigEntry[],
  registry: ModelRegistry,
): ModelConfigEntry | null {
  const existingMatch = existing.find((m) => m.id === id);
  if (existingMatch) return existingMatch;

  const slashIdx = id.indexOf("/");
  if (slashIdx <= 0 || slashIdx === id.length - 1) return null;
  const provider = id.slice(0, slashIdx);
  const rawModelId = id.slice(slashIdx + 1);
  const model = registry.find(provider, rawModelId);
  if (!model) return null;

  return {
    id,
    label: userLabel || model.name,
    provider,
    modelId: rawModelId,
  };
}
