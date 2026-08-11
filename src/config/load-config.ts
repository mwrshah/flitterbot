import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ShortcutBindingsConfig } from "../contracts/control-surface-api.ts";

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ModelThinkingLevel[];
export type PiTransport = "sse" | "websocket" | "websocket-cached" | "auto";
export type Harness = "claude" | "codex";

export function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

export type ModelConfigEntry = {
  id: string;
  label: string;
  provider: string;
  modelId: string;
  thinkingLevel?: ModelThinkingLevel;
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
  tmuxBootstrapMessage?: unknown;
  tmuxEnabled?: unknown;
  extraSkillPaths?: unknown;
  learningsNotePath?: unknown;
  todoistApiKey?: unknown;
  linearApiKey?: unknown;
  harness?: unknown;
};

const ACCEPTED_CONFIG_KEYS = [
  "controlSurfaceHost",
  "controlSurfacePort",
  "controlSurfaceToken",
  "controlSurfaceCommand",
  "models",
  "defaultModel",
  "defaultThinkingLevel",
  "piTransport",
  "stallMinutes",
  "toolTimeoutMinutes",
  "blackboardPath",
  "whatsappAuthDir",
  "whatsappSocketPath",
  "whatsappPidPath",
  "whatsappCliPath",
  "whatsappDaemonPath",
  "claudeCliCommand",
  "projectsDir",
  "projectRoot",
  "sourceRoot",
  "wipeStreamsOnStart",
  "whatsappEnabled",
  "shortcuts",
  "defaultAgentFirstMessage",
  "tmuxBootstrapMessage",
  "tmuxEnabled",
  "extraSkillPaths",
  "learningsNotePath",
  "todoistApiKey",
  "linearApiKey",
  "harness",
] as const satisfies readonly (keyof RawConfigJson)[];

const ACCEPTED_MODEL_CONFIG_KEYS = ["id", "label", "provider", "modelId", "thinkingLevel"] as const;

const ACCEPTED_CONFIG_KEY_SET = new Set<string>(ACCEPTED_CONFIG_KEYS);
const ACCEPTED_MODEL_CONFIG_KEY_SET = new Set<string>(ACCEPTED_MODEL_CONFIG_KEYS);

export type FlitterbotConfig = {
  controlSurfaceHost: string;
  controlSurfacePort: number;
  controlSurfaceToken: string;
  models: ModelConfigEntry[];
  defaultModel: string;
  defaultThinkingLevel: ModelThinkingLevel;
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
  controlSurfaceArchivedSessionsDir: string;
  controlSurfaceAgentDir: string;
  piAgentDir: string;
  memoryPath: string;
  controlSurfacePidPath: string;
  controlSurfaceLogPath: string;
  projectsDir: string;
  wipeStreamsOnStart: boolean;
  whatsappEnabled: boolean;
  shortcuts: ShortcutBindingsConfig;
  defaultAgentFirstMessage: string;
  tmuxBootstrapMessage: string;
  flitterbotSkillsDir: string;
  tmuxEnabled: boolean;
  extraSkillPaths: string[];
  learningsNotePath: string;
  harness: Harness;
};

const HOME = os.homedir();
const FLITTERBOT_DIR = path.join(HOME, ".flitterbot");
const CONFIG_PATH = path.join(FLITTERBOT_DIR, "config.json");
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

function readRequiredJsonFile(filePath: string): RawConfigJson {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing config file: ${filePath}. Run installer to populate config.json.`);
  }
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw)
    throw new Error(`Empty config file: ${filePath}. Run installer to populate config.json.`);
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid config file: ${filePath} must contain a JSON object.`);
  }

  validateKnownConfigKeys(parsed as Record<string, unknown>, filePath);
  return parsed as RawConfigJson;
}

function collectUnknownConfigKeys(raw: Record<string, unknown>): string[] {
  const unknownKeys = Object.keys(raw)
    .filter((key) => !ACCEPTED_CONFIG_KEY_SET.has(key))
    .map((key) => `"${key}"`);

  if (Array.isArray(raw.models)) {
    for (const [index, entry] of raw.models.entries()) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      for (const key of Object.keys(entry)) {
        if (!ACCEPTED_MODEL_CONFIG_KEY_SET.has(key)) {
          unknownKeys.push(`"models[${index}].${key}"`);
        }
      }
    }
  }

  return unknownKeys.sort();
}

export function validateKnownConfigKeys(
  raw: Record<string, unknown>,
  filePath = FLITTERBOT_CONFIG_PATH,
): void {
  const unknownKeys = collectUnknownConfigKeys(raw);
  if (unknownKeys.length === 0) return;

  const keyNoun = unknownKeys.length === 1 ? "key" : "keys";
  const removePhrase = unknownKeys.length === 1 ? "Remove this key" : "Remove these keys";
  throw new Error(
    `Invalid startup config ${filePath}: unknown config ${keyNoun}: ${unknownKeys.join(", ")}. ${removePhrase} from ${filePath}.`,
  );
}

function requireConfigString(raw: RawConfigJson, key: keyof RawConfigJson): string {
  const value = raw[key];
  if (typeof value === "string") return value;
  throw new Error(`Missing required string config key: ${String(key)}`);
}

function optionalConfigString(raw: RawConfigJson, key: keyof RawConfigJson): string {
  const value = raw[key];
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  throw new Error(`Invalid optional string config key: ${String(key)}`);
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

function requireThinkingLevel(raw: RawConfigJson): ModelThinkingLevel {
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

function requireHarness(raw: RawConfigJson): Harness {
  const value = raw.harness;
  if (value === "claude" || value === "codex") return value;
  throw new Error('Invalid required config key harness: expected "claude" or "codex"');
}

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
  const slashIdx = configured.indexOf("/");
  if (slashIdx > 0 && slashIdx < configured.length - 1) return configured;
  throw new Error(
    `Invalid defaultModel "${configured}": expected a models[].id or a "provider/modelId" pair`,
  );
}

export function loadConfig(): FlitterbotConfig {
  ensureDir(FLITTERBOT_DIR);
  ensureDir(path.join(FLITTERBOT_DIR, "logs"));

  const raw = readRequiredJsonFile(CONFIG_PATH);
  const controlSurfaceDir = path.join(FLITTERBOT_DIR, "control-surface");
  const sessionsDir = path.join(controlSurfaceDir, "sessions");
  const archivedSessionsDir = path.join(controlSurfaceDir, "archived-sessions");
  const controlSurfaceAgentDir = path.join(controlSurfaceDir, "agent");
  const piAgentDir = path.join(os.homedir(), ".agents");
  const memoryPath = path.join(FLITTERBOT_DIR, "data", "MEMORY.md");
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
    tmuxBootstrapMessage: optionalConfigString(raw, "tmuxBootstrapMessage"),
    flitterbotSkillsDir: path.join(FLITTERBOT_DIR, "skills"),
    tmuxEnabled: requireConfigBoolean(raw, "tmuxEnabled"),
    extraSkillPaths: parseExtraSkillPaths(raw),
    learningsNotePath: expandHome(requireConfigString(raw, "learningsNotePath")),
    harness: requireHarness(raw),

    controlSurfaceDir,
    controlSurfaceSessionsDir: sessionsDir,
    controlSurfaceArchivedSessionsDir: archivedSessionsDir,
    controlSurfaceAgentDir,
    piAgentDir,
    memoryPath,
    controlSurfacePidPath: pidPath,
    controlSurfaceLogPath: logPath,
  };

  ensureDir(config.projectsDir);
  ensureDir(controlSurfaceDir);
  ensureDir(sessionsDir);
  ensureDir(archivedSessionsDir);
  ensureDir(controlSurfaceAgentDir);
  fs.chmodSync(controlSurfaceAgentDir, 0o700);
  ensureDir(piAgentDir);
  ensureDir(config.flitterbotSkillsDir);
  ensureDir(path.dirname(config.memoryPath));
  ensureDir(path.join(FLITTERBOT_DIR, "data", "tasks"));
  ensureDir(path.join(FLITTERBOT_DIR, "data", "notes"));
  ensureDir(path.dirname(config.learningsNotePath));
  ensureDir(path.dirname(logPath));
  ensureDir(path.dirname(config.blackboardPath));
  ensureDir(path.dirname(config.whatsappSocketPath));
  ensureDir(path.dirname(config.whatsappPidPath));
  ensureDir(config.whatsappAuthDir);

  return config;
}
