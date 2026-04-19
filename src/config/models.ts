import type { FlitterbotConfig, ModelConfigEntry } from "./load-config.ts";

/**
 * Resolve a `ModelConfigEntry` by id, falling back to the config's
 * `defaultModel`. The config invariant (validated in `loadConfig`) guarantees
 * `models` is non-empty and `defaultModel` points at a valid entry, so this
 * always returns a defined value.
 *
 * Throws when an explicit id is supplied but doesn't match any configured
 * entry — surfaces bad input at the boundary rather than silently dropping
 * the user's selection.
 */
export function resolveModelEntry(config: FlitterbotConfig, modelId?: string): ModelConfigEntry {
  if (modelId) {
    const match = config.models.find((m) => m.id === modelId);
    if (!match) {
      throw new Error(
        `Unknown model id "${modelId}" — not in config.models (available: ${config.models
          .map((m) => m.id)
          .join(", ")})`,
      );
    }
    return match;
  }
  const fallback = config.models.find((m) => m.id === config.defaultModel);
  if (fallback) return fallback;
  // Invariant violation — loadConfig should have repaired this. Bail loudly.
  throw new Error(
    `Config invariant violated: defaultModel "${config.defaultModel}" not found in models[]`,
  );
}
