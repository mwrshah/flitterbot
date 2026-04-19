import { getModel } from "@mariozechner/pi-ai";
import type { FlitterbotConfig, ModelConfigEntry } from "./load-config.ts";

/**
 * Resolve a `ModelConfigEntry` by id. Accepts either:
 *
 *   1. A curated id — an entry in `config.models[]` (e.g. `"claude-opus-4-7"`).
 *   2. A composite `provider/modelId` id — resolved on-the-fly against the pi
 *      SDK's full model catalog (e.g. `"cerebras/zai-glm-4.7"`). This lets the
 *      UI offer the entire pi-mono catalog without forcing every model into
 *      `config.models[]`.
 *
 * When `modelId` is omitted, falls back to `config.defaultModel` via route (1).
 *
 * Throws when the id is supplied but matches neither form — surfaces bad
 * input at the boundary rather than silently dropping the user's selection.
 */
export function resolveModelEntry(config: FlitterbotConfig, modelId?: string): ModelConfigEntry {
  if (modelId) {
    const curated = config.models.find((m) => m.id === modelId);
    if (curated) return curated;
    const fromCatalog = resolveCompositeId(modelId);
    if (fromCatalog) return fromCatalog;
    throw new Error(
      `Unknown model id "${modelId}" — not in config.models and not a valid provider/modelId pair in the pi SDK catalog`,
    );
  }
  const fallback =
    config.models.find((m) => m.id === config.defaultModel) ??
    resolveCompositeId(config.defaultModel);
  if (fallback) return fallback;
  // Invariant violation — loadConfig should have repaired this. Bail loudly.
  throw new Error(
    `Config invariant violated: defaultModel "${config.defaultModel}" is neither in models[] nor a valid provider/modelId pair`,
  );
}

/**
 * Parse a `provider/modelId` composite id and synthesize a `ModelConfigEntry`
 * when the pair exists in the pi SDK catalog. Returns null on any mismatch
 * (unknown provider, unknown model, missing separator).
 *
 * Model ids may themselves contain slashes (e.g. `openrouter/ai21/jamba-large-1.7`)
 * so we split on the FIRST slash only — provider is the prefix, everything
 * after is the raw model id.
 */
function resolveCompositeId(compositeId: string): ModelConfigEntry | null {
  const slashIdx = compositeId.indexOf("/");
  if (slashIdx <= 0 || slashIdx === compositeId.length - 1) return null;
  const provider = compositeId.slice(0, slashIdx);
  const rawModelId = compositeId.slice(slashIdx + 1);
  const model = getModel(
    provider as Parameters<typeof getModel>[0],
    rawModelId as Parameters<typeof getModel>[1],
  );
  if (!model) return null;
  return {
    id: compositeId,
    label: `${model.name} (${provider})`,
    provider,
    modelId: rawModelId,
  };
}
