import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ShortcutBindingsConfig } from "../contracts/control-surface-api.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type PiTransport = "sse" | "websocket" | "websocket-cached" | "auto";

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * A selectable model entry shown in the web UI model selector. `id` is the
 * stable UI/persistence identifier; `provider`+`modelId` are what the pi SDK
 * consumes under the hood. `thinkingLevel` optionally overrides the global
 * `defaultThinkingLevel` for this model.
 */
export type ModelConfigEntry = {
  id: string;
  label: string;
  provider: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
};

type RawConfigJson = {
  controlSurfaceHost?: unknown;
  controlSurfacePort?: unknown;
  controlSurfaceToken?: unknown;
  controlSurfaceCommand?: unknown;
  models?: unknown;
  defaultModel?: unknown;
  defaultThinkingLevel?: unknown;
  piTransport?: unknown;
  stallMinutes?: unknown;
  toolTimeoutMinutes?: unknown;
  blackboardPath?: unknown;
  whatsappAuthDir?: unknown;
  whatsappSocketPath?: unknown;
  whatsappPidPath?: unknown;
  whatsappCliPath?: unknown;
  whatsappDaemonPath?: unknown;
  claudeCliCommand?: unknown;
  projectsDir?: unknown;
  projectRoot?: unknown;
  sourceRoot?: unknown;
  wipeStreamsOnStart?: unknown;
  whatsappEnabled?: unknown;
  shortcuts?: unknown;
  defaultAgentFirstMessage?: unknown;
  newStreamFirstMessageFooter?: unknown;
  tmuxEnabled?: unknown;
  extraSkillPaths?: unknown;
};

export type FlitterbotConfig = {
  controlSurfaceHost: string;
  controlSurfacePort: number;
  controlSurfaceToken: string;
  /** Selectable models exposed to the web UI. Always non-empty and defined in config.json. */
  models: ModelConfigEntry[];
  /** Id of the default model (must match one of `models[].id` or be a provider/modelId pair). */
  defaultModel: string;
  /** Global thinking level used for newly-created Pi sessions, unless a model overrides it. */
  defaultThinkingLevel: ThinkingLevel;
  piTransport: PiTransport;
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
  /** First queued instruction sent to the default agent when its session starts. */
  defaultAgentFirstMessage: string;
  /** Footer appended to the first prompt delivered to every newly-created stream orchestrator. */
  newStreamFirstMessageFooter: string;
  /** Deterministic skill root populated by the installer with bundled Flitterbot skills. */
  flitterbotSkillsDir: string;
  /** Include tmux sub-agent orchestration instructions in orchestrator prompts. */
  tmuxEnabled: boolean;
  /** Extra directories to load skills from after the bundled `~/.flitterbot/skills` directory. */
  extraSkillPaths: string[];
};

export const TMUX_SKILL_DIRECTIVE = "/skill:tmux";
export const SUGGESTED_TMUX_FIRST_MESSAGE_FOOTER =
  "IMPORTANT! Before doing  anything else, load the /skill:tmux pls";

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

function readRequiredJsonFile<T>(filePath: string): T {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing config file: ${filePath}. Run installer to populate config.json.`);
  }
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw)
    throw new Error(`Empty config file: ${filePath}. Run installer to populate config.json.`);
  return JSON.parse(raw) as T;
}

function requireConfigString(raw: RawConfigJson, key: keyof RawConfigJson): string {
  const value = raw[key];
  if (typeof value === "string") return value;
  throw new Error(`Missing required string config key: ${String(key)}`);
}

function requireConfigNumber(raw: RawConfigJson, key: keyof RawConfigJson): number {
  const value = raw[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`Missing required numeric config key: ${String(key)}`);
}

function requireConfigBoolean(raw: RawConfigJson, key: keyof RawConfigJson): boolean {
  const value = raw[key];
  if (typeof value === "boolean") return value;
  throw new Error(`Missing required boolean config key: ${String(key)}`);
}

function requireConfigArray(raw: RawConfigJson, key: keyof RawConfigJson): unknown[] {
  const value = raw[key];
  if (Array.isArray(value)) return value;
  throw new Error(`Missing required array config key: ${String(key)}`);
}

function requireConfigObject<T extends Record<string, unknown>>(
  raw: RawConfigJson,
  key: keyof RawConfigJson,
): T {
  const value = raw[key];
  if (value && typeof value === "object" && !Array.isArray(value)) return value as T;
  throw new Error(`Missing required object config key: ${String(key)}`);
}

function requireThinkingLevel(raw: RawConfigJson): ThinkingLevel {
  const value = raw.defaultThinkingLevel;
  if (isThinkingLevel(value)) return value;
  throw new Error(
    `Invalid required config key defaultThinkingLevel: expected one of ${THINKING_LEVELS.join(", ")}`,
  );
}

function requirePiTransport(raw: RawConfigJson): PiTransport {
  const value = raw.piTransport;
  if (
    value === "sse" ||
    value === "websocket" ||
    value === "websocket-cached" ||
    value === "auto"
  ) {
    return value;
  }
  throw new Error(
    "Invalid required config key piTransport: expected sse, websocket, websocket-cached, or auto",
  );
}

/**
 * Expand `~`, resolve to absolute, and de-duplicate while preserving declared order.
 * `extraSkillPaths` is required in config.json; invalid entries fail startup instead
 * of being silently dropped.
 */
function parseExtraSkillPaths(raw: RawConfigJson): string[] {
  const input = requireConfigArray(raw, "extraSkillPaths");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const [index, entry] of input.entries()) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`Invalid extraSkillPaths[${index}]: expected non-empty string`);
    }
    const expanded = expandHome(entry.trim());
    const absolute = path.resolve(expanded);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    out.push(absolute);
  }
  return out;
}

function parseModels(raw: RawConfigJson): ModelConfigEntry[] {
  const input = requireConfigArray(raw, "models");
  if (input.length === 0) throw new Error("Config key models must contain at least one model");

  const seen = new Set<string>();
  return input.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Invalid models[${index}]: expected object`);
    }
    const model = entry as Record<string, unknown>;
    const id = model.id;
    const label = model.label;
    const provider = model.provider;
    const modelId = model.modelId;
    if (typeof id !== "string" || !id.trim()) {
      throw new Error(`Invalid models[${index}].id: expected non-empty string`);
    }
    if (seen.has(id)) throw new Error(`Duplicate model id in config.models: ${id}`);
    seen.add(id);
    if (typeof label !== "string" || !label.trim()) {
      throw new Error(`Invalid models[${index}].label: expected non-empty string`);
    }
    if (typeof provider !== "string" || !provider.trim()) {
      throw new Error(`Invalid models[${index}].provider: expected non-empty string`);
    }
    if (typeof modelId !== "string" || !modelId.trim()) {
      throw new Error(`Invalid models[${index}].modelId: expected non-empty string`);
    }

    const parsed: ModelConfigEntry = { id, label, provider, modelId };
    if (model.thinkingLevel !== undefined) {
      if (!isThinkingLevel(model.thinkingLevel)) {
        throw new Error(
          `Invalid models[${index}].thinkingLevel: expected one of ${THINKING_LEVELS.join(", ")}`,
        );
      }
      parsed.thinkingLevel = model.thinkingLevel;
    }
    return parsed;
  });
}

function resolveDefaultModel(raw: RawConfigJson, models: ModelConfigEntry[]): string {
  const configured = requireConfigString(raw, "defaultModel");
  if (models.some((m) => m.id === configured)) return configured;
  const [provider, modelId] = configured.split("/", 2);
  if (provider && modelId) return configured;
  throw new Error(
    `Invalid defaultModel "${configured}": expected a models[].id or provider/modelId pair`,
  );
}

export function validateTmuxStreamFooterConfig(
  config: Pick<FlitterbotConfig, "newStreamFirstMessageFooter" | "tmuxEnabled">,
): void {
  const footerHasTmuxSkill = config.newStreamFirstMessageFooter.includes(TMUX_SKILL_DIRECTIVE);

  if (!config.tmuxEnabled && footerHasTmuxSkill) {
    throw new Error(
      `Invalid startup config ${FLITTERBOT_CONFIG_PATH}: newStreamFirstMessageFooter includes ${TMUX_SKILL_DIRECTIVE} but tmuxEnabled is false. Remove the tmux skill footer or set "tmuxEnabled": true.`,
    );
  }

  if (config.tmuxEnabled && !footerHasTmuxSkill) {
    throw new Error(
      `Invalid startup config ${FLITTERBOT_CONFIG_PATH}: tmuxEnabled is true but newStreamFirstMessageFooter does not include ${TMUX_SKILL_DIRECTIVE}. Add "newStreamFirstMessageFooter": "${SUGGESTED_TMUX_FIRST_MESSAGE_FOOTER}" to ${FLITTERBOT_CONFIG_PATH}.`,
    );
  }
}

export function loadConfig(): FlitterbotConfig {
  ensureDir(FLITTERBOT_DIR);
  ensureDir(path.join(FLITTERBOT_DIR, "logs"));

  const raw = readRequiredJsonFile<RawConfigJson>(CONFIG_PATH);
  const controlSurfaceDir = path.join(FLITTERBOT_DIR, "control-surface");
  const sessionsDir = path.join(controlSurfaceDir, "sessions");
  const agentDir = path.join(controlSurfaceDir, "agent");
  const pidPath = path.join(controlSurfaceDir, "server.pid");
  const logPath = path.join(FLITTERBOT_DIR, "logs", "control-surface.log");

  const models = parseModels(raw);
  const defaultModel = resolveDefaultModel(raw, models);
  const config: FlitterbotConfig = {
    controlSurfaceHost: requireConfigString(raw, "controlSurfaceHost"),
    controlSurfacePort: requireConfigNumber(raw, "controlSurfacePort"),
    controlSurfaceToken: requireConfigString(raw, "controlSurfaceToken"),
    models,
    defaultModel,
    defaultThinkingLevel: requireThinkingLevel(raw),
    piTransport: requirePiTransport(raw),
    stallMinutes: requireConfigNumber(raw, "stallMinutes"),
    toolTimeoutMinutes: requireConfigNumber(raw, "toolTimeoutMinutes"),
    blackboardPath: expandHome(requireConfigString(raw, "blackboardPath")),
    whatsappAuthDir: expandHome(requireConfigString(raw, "whatsappAuthDir")),
    whatsappSocketPath: expandHome(requireConfigString(raw, "whatsappSocketPath")),
    whatsappPidPath: expandHome(requireConfigString(raw, "whatsappPidPath")),
    whatsappCliPath: expandHome(requireConfigString(raw, "whatsappCliPath")),
    whatsappDaemonPath: expandHome(requireConfigString(raw, "whatsappDaemonPath")),
    claudeCliCommand: requireConfigString(raw, "claudeCliCommand"),
    projectsDir: expandHome(requireConfigString(raw, "projectsDir")),
    wipeStreamsOnStart: requireConfigBoolean(raw, "wipeStreamsOnStart"),
    whatsappEnabled: requireConfigBoolean(raw, "whatsappEnabled"),
    shortcuts: requireConfigObject<ShortcutBindingsConfig>(raw, "shortcuts"),
    defaultAgentFirstMessage: requireConfigString(raw, "defaultAgentFirstMessage"),
    newStreamFirstMessageFooter: requireConfigString(raw, "newStreamFirstMessageFooter"),
    flitterbotSkillsDir: path.join(FLITTERBOT_DIR, "skills"),
    tmuxEnabled: requireConfigBoolean(raw, "tmuxEnabled"),
    extraSkillPaths: parseExtraSkillPaths(raw),

    controlSurfaceDir,
    controlSurfaceSessionsDir: sessionsDir,
    controlSurfaceAgentDir: agentDir,
    controlSurfacePidPath: pidPath,
    controlSurfaceLogPath: logPath,
  };

  validateTmuxStreamFooterConfig(config);

  ensureDir(config.projectsDir);
  ensureDir(controlSurfaceDir);
  ensureDir(sessionsDir);
  ensureDir(agentDir);
  ensureDir(config.flitterbotSkillsDir);
  ensureDir(path.join(FLITTERBOT_DIR, "data", "tasks"));
  ensureDir(path.join(FLITTERBOT_DIR, "data", "notes"));
  ensureDir(path.dirname(logPath));
  ensureDir(path.dirname(config.blackboardPath));
  ensureDir(path.dirname(config.whatsappSocketPath));
  ensureDir(path.dirname(config.whatsappPidPath));
  ensureDir(config.whatsappAuthDir);

  return config;
}
