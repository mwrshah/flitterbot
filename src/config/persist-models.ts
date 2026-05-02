import fs from "node:fs";
import path from "node:path";
import {
  FLITTERBOT_CONFIG_PATH,
  type ModelConfigEntry,
  type ThinkingLevel,
} from "./load-config.ts";

/**
 * Rewrite model-selector config fields in the user's `~/.flitterbot/config.json`
 * without disturbing any other keys. Uses an atomic temp-file + rename so a
 * crash mid-write can never produce a half-written config.
 *
 * All other fields of `config.json` are preserved verbatim (including any
 * unknown keys the user added by hand) — we read → patch → write, nothing
 * else. Pretty-printed with 2-space indent + trailing newline to match the
 * shape `loadConfig` emits.
 */
export function persistModelsToConfigFile(update: {
  models: ModelConfigEntry[];
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
}): void {
  const existing = readConfigFileOrEmpty();
  const { piThinkingLevel: _legacyPiThinkingLevel, ...existingWithoutLegacy } = existing;
  const next: Record<string, unknown> = { ...existingWithoutLegacy, models: update.models };
  if (update.defaultModel !== undefined) {
    next.defaultModel = update.defaultModel;
  }
  if (update.defaultThinkingLevel !== undefined) {
    next.defaultThinkingLevel = update.defaultThinkingLevel;
  }
  atomicWriteJson(FLITTERBOT_CONFIG_PATH, next);
}

function readConfigFileOrEmpty(): Record<string, unknown> {
  if (!fs.existsSync(FLITTERBOT_CONFIG_PATH)) return {};
  const raw = fs.readFileSync(FLITTERBOT_CONFIG_PATH, "utf8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

function atomicWriteJson(targetPath: string, data: unknown): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, targetPath);
}
