import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config/load-config.ts";
import type { WhatsAppDaemonRuntimeStatus as WhatsAppDaemonStatus } from "../contracts/index.ts";
import { loadWhatsAppConfig } from "./config.ts";
import { sendDaemonCommand } from "./ipc.ts";
import {
  getWhatsAppAuthDir,
  getWhatsAppHome,
  getWhatsAppLogPath,
  getWhatsAppPidPath,
  getWhatsAppSocketPath,
} from "./paths.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readDaemonPid(): number | undefined {
  try {
    const raw = readFileSync(getWhatsAppPidPath(), "utf8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveDaemonLaunch(): { args: string[] } {
  const config = loadConfig();
  if (config.whatsappDaemonPath && existsSync(config.whatsappDaemonPath)) {
    return { args: [config.whatsappDaemonPath] };
  }

  const tsPath = fileURLToPath(new URL("./daemon.ts", import.meta.url));
  if (existsSync(tsPath)) {
    return { args: ["--experimental-strip-types", tsPath] };
  }

  throw new Error("Unable to locate WhatsApp daemon entrypoint.");
}

function listDaemonPids(): number[] {
  const candidates = new Set<string>([
    path.join(getWhatsAppHome(), "daemon.js"),
    fileURLToPath(new URL("./daemon.ts", import.meta.url)),
    getWhatsAppSocketPath(),
  ]);

  const config = loadConfig();
  if (config.whatsappDaemonPath) {
    candidates.add(config.whatsappDaemonPath);
  }

  try {
    const output = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const match = line.match(/^(\d+)\s+(.*)$/);
        if (!match) return [];
        const pid = Number(match[1]);
        const command = match[2]!;
        if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return [];
        return [...candidates].some((candidate) => command.includes(candidate)) ? [pid] : [];
      });
  } catch {
    return [];
  }
}

async function terminateDaemonPids(
  pids: number[],
  signal: NodeJS.Signals,
  waitMs: number,
): Promise<number[]> {
  const unique = [...new Set(pids)].filter(
    (pid) => Number.isInteger(pid) && pid > 0 && isProcessAlive(pid),
  );
  if (unique.length === 0) return [];

  for (const pid of unique) {
    try {
      process.kill(pid, signal);
    } catch {
      // ignore
    }
  }

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const alive = unique.filter((pid) => isProcessAlive(pid));
    if (alive.length === 0) return [];
    await sleep(150);
  }

  return unique.filter((pid) => isProcessAlive(pid));
}

export async function stopCompetingDaemonProcesses(excludePids: number[] = []): Promise<number[]> {
  const excluded = new Set(excludePids);
  const initial = listDaemonPids().filter((pid) => !excluded.has(pid));
  const survivors = await terminateDaemonPids(initial, "SIGTERM", 3000);
  const stubborn = survivors.filter((pid) => !excluded.has(pid));
  if (stubborn.length === 0) return initial;
  await terminateDaemonPids(stubborn, "SIGKILL", 1000);
  return initial;
}

export async function startDaemonProcess(
  options: { authMode?: boolean; pairingCode?: boolean } = {},
): Promise<number> {
  await stopCompetingDaemonProcesses();

  const launch = resolveDaemonLaunch();
  const args = [...launch.args];

  if (options.authMode) {
    args.push("--auth");
  }
  if (options.pairingCode) {
    args.push("--pairing-code");
  }

  mkdirSync(path.dirname(getWhatsAppLogPath()), { recursive: true, mode: 0o700 });
  const logFd = openSync(getWhatsAppLogPath(), "a", 0o600);
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();

  return child.pid ?? 0;
}

export async function waitForDaemonReady(
  timeoutMs = loadWhatsAppConfig().daemonStartupTimeoutMs,
): Promise<WhatsAppDaemonStatus> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;

  while (Date.now() < deadline) {
    try {
      const response = await sendDaemonCommand({ command: "status" }, { timeoutMs: 1500 });
      if (response.daemon) {
        return response.daemon;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    await sleep(250);
  }

  throw lastError ?? new Error("Timed out waiting for WhatsApp daemon to become ready");
}

export async function runForegroundDaemonProcess(
  options: { pairingCode?: boolean } = {},
): Promise<number> {
  await stopCompetingDaemonProcesses();

  const launch = resolveDaemonLaunch();
  const args = [...launch.args, "--auth"];
  if (options.pairingCode) {
    args.push("--pairing-code");
  }

  return await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: "inherit",
      env: { ...process.env, AUTONOMA_WA_EXIT_AFTER_AUTH: "1" },
    });

    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 0));
  });
}

export async function getDaemonStatus(): Promise<WhatsAppDaemonStatus | undefined> {
  try {
    const response = await sendDaemonCommand({ command: "status" }, { timeoutMs: 1500 });
    return response.daemon;
  } catch {
    const pid = readDaemonPid();
    if (!pid || !isProcessAlive(pid)) {
      return undefined;
    }

    return {
      ok: true,
      pid,
      status: "starting",
      socketPath: getWhatsAppSocketPath(),
      authPath: getWhatsAppAuthDir(),
      startedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      reconnectAttempt: 0,
      requiresManualAuth: false,
    };
  }
}

export async function stopDaemonProcess(): Promise<WhatsAppDaemonStatus | undefined> {
  const pid = readDaemonPid();

  try {
    await sendDaemonCommand({ command: "shutdown" }, { timeoutMs: 3000 });
  } catch {
    if (pid && isProcessAlive(pid)) {
      process.kill(pid, "SIGTERM");
    }
  }

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const runningPid = readDaemonPid();
    if (!runningPid || !isProcessAlive(runningPid)) {
      await stopCompetingDaemonProcesses();
      return undefined;
    }
    await sleep(150);
  }

  await stopCompetingDaemonProcesses();
  return await getDaemonStatus();
}
