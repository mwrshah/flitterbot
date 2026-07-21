import type { FlitterbotConfig, ModelConfigEntry } from "./load-config.ts";

export function resolveModelEntryId(
  config: FlitterbotConfig,
  provider: string,
  modelId: string,
): string {
  return (
    config.models.find((entry) => entry.provider === provider && entry.modelId === modelId)?.id ??
    `${provider}/${modelId}`
  );
}

export function resolveModelEntry(config: FlitterbotConfig, modelId?: string): ModelConfigEntry {
  if (modelId) {
    const curated = config.models.find((m) => m.id === modelId);
    if (curated) return curated;
    const fromComposite = resolveCompositeId(modelId);
    if (fromComposite) return fromComposite;
    throw new Error(
      `Unknown model id "${modelId}" — not in config.models and not a "provider/modelId" pair`,
    );
  }
  const fallback =
    config.models.find((m) => m.id === config.defaultModel) ??
    resolveCompositeId(config.defaultModel);
  if (fallback) return fallback;
  throw new Error(
    `Config invariant violated: defaultModel "${config.defaultModel}" is neither in models[] nor a "provider/modelId" pair`,
  );
}

// Split a composite "provider/modelId" id into a config entry. The first slash
// separates provider from modelId, so multi-segment model slugs like
// "truefoundry/claude-group/claude-sonnet-4-6" resolve to provider="truefoundry".
// Existence is validated later against the Pi ModelRegistry (built-in catalog +
// ~/.pi/agent/models.json), not here.
function resolveCompositeId(compositeId: string): ModelConfigEntry | null {
  const slashIdx = compositeId.indexOf("/");
  if (slashIdx <= 0 || slashIdx === compositeId.length - 1) return null;
  const provider = compositeId.slice(0, slashIdx);
  const modelId = compositeId.slice(slashIdx + 1);
  return {
    id: compositeId,
    label: compositeId,
    provider,
    modelId,
  };
}
