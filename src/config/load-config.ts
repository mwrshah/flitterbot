import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ShortcutBindingsConfig } from "../contracts/control-surface-api.ts";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * A selectable model entry shown in the web UI model selector. `id` is the
 * stable UI/persistence identifier; `provider`+`modelId` are what the pi SDK
 * consumes under the hood. `thinkingLevel` optionally overrides the global
 * `piThinkingLevel` default for this model.
 */
export type ModelConfigEntry = {
  id: string;
  label: string;
  provider: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
};

/**
 * Seed models written to config.json on first boot. Ordered by default-ness:
 * the first entry becomes `defaultModel` when unset. Covers the three models
 * the user explicitly called out (current Anthropic default, Sonnet fallback,
 * and GLM-4.7 on Cerebras for the fast-cheap path).
 */
const SEED_MODELS: ModelConfigEntry[] = [
  {
    id: "claude-opus-4-7",
    label: "Claude Opus 4.7",
    provider: "anthropic",
    modelId: "claude-opus-4-7",
  },
  {
    id: "claude-sonnet-4-5",
    label: "Claude Sonnet 4.5",
    provider: "anthropic",
    modelId: "claude-sonnet-4-5",
  },
  {
    id: "zai-glm-4.7",
    label: "Z.AI GLM-4.7 (Cerebras)",
    provider: "cerebras",
    modelId: "zai-glm-4.7",
  },
];

type RawConfigJson = {
  controlSurfaceHost?: string;
  controlSurfacePort?: number;
  controlSurfaceToken?: string;
  controlSurfaceCommand?: string;
  models?: ModelConfigEntry[];
  defaultModel?: string;
  piThinkingLevel?: ThinkingLevel;
  stallMinutes?: number;
  toolTimeoutMinutes?: number;
  blackboardPath?: string;
  whatsappAuthDir?: string;
  whatsappSocketPath?: string;
  whatsappPidPath?: string;
  whatsappCliPath?: string;
  whatsappDaemonPath?: string;
  claudeCliCommand?: string;
  projectsDir?: string;
  projectRoot?: string;
  sourceRoot?: string;
  wipeStreamsOnStart?: boolean;
  whatsappEnabled?: boolean;
  shortcuts?: ShortcutBindingsConfig;
  defaultAgentBootstrapPrompt?: string;
  orchestratorBootstrapFooterPrompt?: string;
  extraSkillPaths?: string[];
};

export type FlitterbotConfig = {
  controlSurfaceHost: string;
  controlSurfacePort: number;
  controlSurfaceToken: string;
  /** Selectable models exposed to the web UI. Always non-empty — seeded on first boot. */
  models: ModelConfigEntry[];
  /** Id of the default model (must match one of `models[].id`). */
  defaultModel: string;
  piThinkingLevel: ThinkingLevel;
  stallMinutes: number;
  toolTimeoutMinutes: number;
  blackboardPath: string;
  whatsappAuthDir: string;
  whatsappSocketPath: string;
  whatsappPidPath: string;
  whatsappCliPath: string;
  whatsappDaemonPath: string;
  claudeCliCommand: string;
  controlSurfaceDir: string;
  controlSurfaceSessionsDir: string;
  controlSurfaceAgentDir: string;
  controlSurfacePidPath: string;
  controlSurfaceLogPath: string;
  projectsDir: string;
  wipeStreamsOnStart: boolean;
  whatsappEnabled: boolean;
  shortcuts: ShortcutBindingsConfig;
  defaultAgentBootstrapPrompt: string;
  orchestratorBootstrapFooterPrompt: string;
  /**
   * Extra directories to load skills from, in addition to the built-in
   * `~/.agents/skills/` and `~/.claude/skills/` locations. Paths are expanded
   * (`~` → home), resolved to absolute, de-duplicated, and order is preserved.
   * Missing paths are skipped with a warning. Name collisions with earlier
   * paths are logged and the earlier skill wins.
   */
  extraSkillPaths: string[];
};

const HOME = os.homedir();
const FLITTERBOT_DIR = path.join(HOME, ".flitterbot");
const CONFIG_PATH = path.join(FLITTERBOT_DIR, "config.json");

/** Absolute path to the user's ~/.flitterbot/config.json. Exported so helpers
 *  that mutate specific fields (e.g. the pin/unpin endpoint) can write back
 *  without duplicating the path-resolution logic. */
export const FLITTERBOT_CONFIG_PATH = CONFIG_PATH;

function expandHome(value: string): string {
  if (!value) return value;
  if (value === "~") return HOME;
  if (value.startsWith("~/")) return path.join(HOME, value.slice(2));
  return value;
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonFile<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return undefined;
  return JSON.parse(raw) as T;
}

/**
 * Expand `~`, resolve to absolute, de-duplicate (preserving declared order),
 * and drop non-string / empty entries. Existence is NOT checked here — the
 * consumer (resource loader) re-checks and skips missing dirs with a warning,
 * and we also emit our own warn log at agent-creation time. Validating here
 * too would either double-log or require coupling config to a logger.
 */
function normalizeExtraSkillPaths(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of input) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const expanded = expandHome(trimmed);
    const absolute = path.resolve(expanded);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    out.push(absolute);
  }
  return out;
}

/**
 * Normalize and validate the `models` array from raw config. Drops entries
 * missing required fields, de-duplicates by `id` (first wins), and falls back
 * to the seeded defaults when the result is empty.
 */
function normalizeModels(input: unknown): ModelConfigEntry[] {
  if (!Array.isArray(input)) return [...SEED_MODELS];
  const seen = new Set<string>();
  const out: ModelConfigEntry[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Partial<ModelConfigEntry>;
    if (
      typeof e.id !== "string" ||
      !e.id.trim() ||
      typeof e.label !== "string" ||
      !e.label.trim() ||
      typeof e.provider !== "string" ||
      !e.provider.trim() ||
      typeof e.modelId !== "string" ||
      !e.modelId.trim()
    ) {
      continue;
    }
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const normalized: ModelConfigEntry = {
      id: e.id,
      label: e.label,
      provider: e.provider,
      modelId: e.modelId,
    };
    if (typeof e.thinkingLevel === "string") {
      normalized.thinkingLevel = e.thinkingLevel as ThinkingLevel;
    }
    out.push(normalized);
  }
  return out.length > 0 ? out : [...SEED_MODELS];
}

/**
 * Resolve the effective `defaultModel` id. Accepts either a curated `models[]`
 * entry id OR a composite `provider/modelId` string (which the full pi SDK
 * catalog uses). Actual catalog resolution happens at request time via
 * `resolveModelEntry` — here we just keep the configured value when it looks
 * structurally plausible, and fall back to the first curated model id when it
 * doesn't.
 */
function resolveDefaultModel(configured: unknown, models: ModelConfigEntry[]): string {
  const fallback = models[0]?.id ?? SEED_MODELS[0]!.id;
  if (typeof configured !== "string" || !configured) return fallback;
  if (models.some((m) => m.id === configured)) return configured;
  // Composite form `provider/modelId` — keep as-is; real validation happens
  // when a session actually instantiates the model.
  if (configured.includes("/")) return configured;
  return fallback;
}

export function loadConfig(): FlitterbotConfig {
  ensureDir(FLITTERBOT_DIR);
  ensureDir(path.join(FLITTERBOT_DIR, "logs"));

  const raw = readJsonFile<RawConfigJson>(CONFIG_PATH) ?? {};
  const controlSurfaceDir = path.join(FLITTERBOT_DIR, "control-surface");
  const sessionsDir = path.join(controlSurfaceDir, "sessions");
  const agentDir = path.join(controlSurfaceDir, "agent");
  const pidPath = path.join(controlSurfaceDir, "server.pid");
  const logPath = path.join(FLITTERBOT_DIR, "logs", "control-surface.log");
  const blackboardPath = expandHome(raw.blackboardPath ?? "~/.flitterbot/blackboard.db");
  const whatsappAuthDir = expandHome(raw.whatsappAuthDir ?? "~/.flitterbot/whatsapp/auth");
  const whatsappSocketPath = expandHome(
    raw.whatsappSocketPath ?? "~/.flitterbot/whatsapp/daemon.sock",
  );
  const whatsappPidPath = expandHome(raw.whatsappPidPath ?? "~/.flitterbot/whatsapp/daemon.pid");
  const whatsappCliPath = expandHome(raw.whatsappCliPath ?? "~/.flitterbot/whatsapp/cli.js");
  const whatsappDaemonPath = expandHome(
    raw.whatsappDaemonPath ?? "~/.flitterbot/whatsapp/daemon.js",
  );
  const projectsDir = expandHome(raw.projectsDir ?? "~/development");
  const wipeStreamsOnStart = raw.wipeStreamsOnStart ?? process.env.FLITTERBOT_WIPE_STREAMS === "1";
  const whatsappEnabled =
    process.env.WHATSAPP_ENABLED !== undefined
      ? process.env.WHATSAPP_ENABLED !== "0" &&
        process.env.WHATSAPP_ENABLED.toLowerCase() !== "false"
      : (raw.whatsappEnabled ?? true);
  const shortcuts = raw.shortcuts ?? {};
  const defaultAgentBootstrapPrompt =
    raw.defaultAgentBootstrapPrompt ??
    "/todoist /my-obsidian\n\nRun ls on the project repositories directory.";
  const orchestratorBootstrapFooterPrompt = raw.orchestratorBootstrapFooterPrompt ?? "";
  const extraSkillPaths = normalizeExtraSkillPaths(raw.extraSkillPaths);
  const configuredClaudeCliCommand = raw.claudeCliCommand ?? "";
  const models = normalizeModels(raw.models);
  const defaultModel = resolveDefaultModel(raw.defaultModel, models);
  const config: FlitterbotConfig = {
    controlSurfaceHost: raw.controlSurfaceHost ?? "127.0.0.1",
    controlSurfacePort: raw.controlSurfacePort ?? 18820,
    controlSurfaceToken: raw.controlSurfaceToken ?? crypto.randomUUID(),
    models,
    defaultModel,
    piThinkingLevel: raw.piThinkingLevel ?? "high",
    stallMinutes: raw.stallMinutes ?? 15,
    toolTimeoutMinutes: raw.toolTimeoutMinutes ?? 4,
    blackboardPath,
    whatsappAuthDir,
    whatsappSocketPath,
    whatsappPidPath,
    whatsappCliPath,
    whatsappDaemonPath,
    claudeCliCommand:
      configuredClaudeCliCommand && configuredClaudeCliCommand !== "claude"
        ? configuredClaudeCliCommand
        : "claude --dangerously-skip-permissions",
    projectsDir,
    wipeStreamsOnStart,
    whatsappEnabled,
    shortcuts,
    defaultAgentBootstrapPrompt,
    orchestratorBootstrapFooterPrompt,
    extraSkillPaths,

    controlSurfaceDir,
    controlSurfaceSessionsDir: sessionsDir,
    controlSurfaceAgentDir: agentDir,
    controlSurfacePidPath: pidPath,
    controlSurfaceLogPath: logPath,
  };

  ensureDir(projectsDir);
  ensureDir(controlSurfaceDir);
  ensureDir(sessionsDir);
  ensureDir(agentDir);
  ensureDir(path.dirname(logPath));
  ensureDir(path.dirname(blackboardPath));
  ensureDir(path.dirname(whatsappSocketPath));
  ensureDir(path.dirname(whatsappPidPath));
  ensureDir(whatsappAuthDir);

  // Clean cutover: drop any legacy `piModel` field so config.json reflects the
  // new single source of truth (`models` + `defaultModel`).
  const { piModel: _legacyPiModel, ...rawWithoutLegacy } = raw as RawConfigJson & {
    piModel?: string;
  };
  const nextPersisted = {
    ...rawWithoutLegacy,
    controlSurfaceHost: config.controlSurfaceHost,
    controlSurfacePort: config.controlSurfacePort,
    controlSurfaceToken: config.controlSurfaceToken,
    models: config.models,
    defaultModel: config.defaultModel,
    piThinkingLevel: config.piThinkingLevel,
    stallMinutes: config.stallMinutes,
    toolTimeoutMinutes: config.toolTimeoutMinutes,
    blackboardPath: config.blackboardPath,
    whatsappAuthDir: config.whatsappAuthDir,
    whatsappSocketPath: config.whatsappSocketPath,
    whatsappPidPath: config.whatsappPidPath,
    whatsappCliPath: config.whatsappCliPath,
    whatsappDaemonPath: config.whatsappDaemonPath,
    claudeCliCommand: config.claudeCliCommand,
    projectsDir: config.projectsDir,
    wipeStreamsOnStart: config.wipeStreamsOnStart,
    whatsappEnabled: config.whatsappEnabled,
    shortcuts: config.shortcuts,
    defaultAgentBootstrapPrompt: config.defaultAgentBootstrapPrompt,
    orchestratorBootstrapFooterPrompt: config.orchestratorBootstrapFooterPrompt,
    extraSkillPaths: config.extraSkillPaths,
  };

  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(nextPersisted, null, 2)}\n`, "utf8");
  return config;
}
