import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type RawConfigJson = {
  controlSurfaceHost?: string;
  controlSurfacePort?: number;
  controlSurfaceToken?: string;
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
  wipeWorkstreamsOnStart?: boolean;
  whatsappEnabled?: boolean;
};

export type AutonomaConfig = {
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
  controlSurfacePromptPath: string;
  projectsDir: string;
  wipeWorkstreamsOnStart: boolean;
  whatsappEnabled: boolean;
};

const HOME = os.homedir();
const AUTONOMA_DIR = path.join(HOME, ".autonoma");
const CONFIG_PATH = path.join(AUTONOMA_DIR, "config.json");

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

export function loadConfig(): AutonomaConfig {
  ensureDir(AUTONOMA_DIR);
  ensureDir(path.join(AUTONOMA_DIR, "logs"));

  const raw = readJsonFile<RawConfigJson>(CONFIG_PATH) ?? {};
  const controlSurfaceDir = path.join(AUTONOMA_DIR, "control-surface");
  const sessionsDir = path.join(controlSurfaceDir, "sessions");
  const agentDir = path.join(controlSurfaceDir, "agent");
  const promptPath = path.join(agentDir, "system-prompt.md");
  const pidPath = path.join(controlSurfaceDir, "server.pid");
  const logPath = path.join(AUTONOMA_DIR, "logs", "control-surface.log");
  const blackboardPath = expandHome(raw.blackboardPath ?? "~/.autonoma/blackboard.db");
  const whatsappAuthDir = expandHome(raw.whatsappAuthDir ?? "~/.autonoma/whatsapp/auth");
  const whatsappSocketPath = expandHome(
    raw.whatsappSocketPath ?? "~/.autonoma/whatsapp/daemon.sock",
  );
  const whatsappPidPath = expandHome(raw.whatsappPidPath ?? "~/.autonoma/whatsapp/daemon.pid");
  const whatsappCliPath = expandHome(raw.whatsappCliPath ?? "~/.autonoma/whatsapp/cli.js");
  const whatsappDaemonPath = expandHome(raw.whatsappDaemonPath ?? "~/.autonoma/whatsapp/daemon.js");
  const projectsDir = expandHome(raw.projectsDir ?? "~/development");
  const wipeWorkstreamsOnStart =
    raw.wipeWorkstreamsOnStart ?? process.env.AUTONOMA_WIPE_WORKSTREAMS === "1";
  const whatsappEnabled =
    process.env.WHATSAPP_ENABLED !== undefined
      ? process.env.WHATSAPP_ENABLED !== "0" &&
        process.env.WHATSAPP_ENABLED.toLowerCase() !== "false"
      : (raw.whatsappEnabled ?? true);
  const configuredPiModel = raw.piModel ?? "";
  const configuredClaudeCliCommand = raw.claudeCliCommand ?? "";
  const config: AutonomaConfig = {
    controlSurfaceHost: raw.controlSurfaceHost ?? "127.0.0.1",
    controlSurfacePort: raw.controlSurfacePort ?? 18820,
    controlSurfaceToken: raw.controlSurfaceToken ?? crypto.randomUUID(),
    piModel:
      configuredPiModel && configuredPiModel !== "claude-sonnet-4-6"
        ? configuredPiModel
        : "claude-opus-4-6",
    piThinkingLevel: raw.piThinkingLevel ?? "medium",
    stallMinutes: raw.stallMinutes ?? 15,
    toolTimeoutMinutes: raw.toolTimeoutMinutes ?? 60,
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
    wipeWorkstreamsOnStart,
    whatsappEnabled,

    controlSurfaceDir,
    controlSurfaceSessionsDir: sessionsDir,
    controlSurfaceAgentDir: agentDir,
    controlSurfacePidPath: pidPath,
    controlSurfaceLogPath: logPath,
    controlSurfacePromptPath: promptPath,
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
    wipeWorkstreamsOnStart: config.wipeWorkstreamsOnStart,
    whatsappEnabled: config.whatsappEnabled,
  };

  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(nextPersisted, null, 2)}\n`, "utf8");
  return config;
}
