import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ShortcutBindingsConfig } from "../contracts/control-surface-api.ts";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type RawConfigJson = {
  controlSurfaceHost?: string;
  controlSurfacePort?: number;
  controlSurfaceToken?: string;
  controlSurfaceCommand?: string;
  piModel?: string;
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
};

export type FlitterbotConfig = {
  controlSurfaceHost: string;
  controlSurfacePort: number;
  controlSurfaceToken: string;
  piModel: string;
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
};

const HOME = os.homedir();
const FLITTERBOT_DIR = path.join(HOME, ".flitterbot");
const CONFIG_PATH = path.join(FLITTERBOT_DIR, "config.json");

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
  const configuredPiModel = raw.piModel ?? "";
  const configuredClaudeCliCommand = raw.claudeCliCommand ?? "";
  const config: FlitterbotConfig = {
    controlSurfaceHost: raw.controlSurfaceHost ?? "127.0.0.1",
    controlSurfacePort: raw.controlSurfacePort ?? 18820,
    controlSurfaceToken: raw.controlSurfaceToken ?? crypto.randomUUID(),
    piModel: configuredPiModel || "claude-opus-4-7",
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

  const nextPersisted = {
    ...raw,
    controlSurfaceHost: config.controlSurfaceHost,
    controlSurfacePort: config.controlSurfacePort,
    controlSurfaceToken: config.controlSurfaceToken,
    piModel: config.piModel,
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
  };

  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(nextPersisted, null, 2)}\n`, "utf8");
  return config;
}
