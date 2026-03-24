import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type {
  TmuxPaneSnapshot,
  TmuxSessionInspection,
  TmuxSessionSummary,
  TmuxUiState,
} from "../contracts/index.ts";

const execFile = promisify(execFileCallback);
const INFERENCE_MARKERS = /[✢✳✶✻✽]/u;
const COLOR_BEFORE_MARKER = /38;2;(\d+);(\d+);(\d+)(?:(?!38;2;|\u001b\[0m).){0,40}[✢✳✶✻✽]/gsu;

class TmuxError extends Error {
  readonly code?: number | string;
  readonly stderr?: string;

  constructor(message: string, options: { code?: number | string; stderr?: string } = {}) {
    super(message);
    this.name = "TmuxError";
    this.code = options.code;
    this.stderr = options.stderr;
  }
}

async function runTmux(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFile("tmux", args, { encoding: "utf8" });
    return stdout;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string; code?: number | string };
    throw new TmuxError(`tmux ${args.join(" ")} failed`, {
      code: failure.code,
      stderr: failure.stderr,
    });
  }
}

async function runOptionalTmux(args: string[]): Promise<string | null> {
  try {
    return await runTmux(args);
  } catch (error) {
    if (error instanceof TmuxError) {
      return null;
    }
    throw error;
  }
}

function getPrimaryTarget(sessionName: string): string {
  return sessionName;
}

function warmInferenceColor(r: number, b: number): boolean {
  return r > 200 && r - b > 50;
}

function detectUiStateFromCapture(capture: string, currentCommand: string | null): TmuxUiState {
  if (!currentCommand || currentCommand !== "claude") {
    return currentCommand ? "BUSY_OTHER" : "NO_CLAUDE";
  }

  if (!INFERENCE_MARKERS.test(capture)) {
    return "IDLE";
  }

  for (const match of capture.matchAll(COLOR_BEFORE_MARKER)) {
    const r = Number(match[1]);
    const b = Number(match[3]);
    if (warmInferenceColor(r, b)) {
      return "INFERRING";
    }
  }

  return "IDLE";
}

async function getPaneSnapshot(target: string): Promise<TmuxPaneSnapshot | null> {
  const paneIdOutput = await runOptionalTmux(["display-message", "-t", target, "-p", "#{pane_id}"]);
  if (paneIdOutput === null) {
    return null;
  }

  const [panePidOutput, currentCommandOutput, captureOutput] = await Promise.all([
    runOptionalTmux(["display-message", "-t", target, "-p", "#{pane_pid}"]),
    runOptionalTmux(["display-message", "-t", target, "-p", "#{pane_current_command}"]),
    runOptionalTmux(["capture-pane", "-t", target, "-e", "-p"]),
  ]);

  const currentCommand = currentCommandOutput?.trim() || null;
  const capture = captureOutput ?? "";

  return {
    target,
    paneId: paneIdOutput.trim(),
    panePid: panePidOutput ? Number(panePidOutput.trim()) || null : null,
    currentCommand,
    capture,
    uiState: detectUiStateFromCapture(capture, currentCommand),
  };
}

export async function tmuxSessionExists(sessionName: string): Promise<boolean> {
  const output = await runOptionalTmux(["has-session", "-t", sessionName]);
  return output !== null;
}

export async function listTmuxSessions(): Promise<TmuxSessionSummary[]> {
  const output = await runOptionalTmux([
    "list-sessions",
    "-F",
    "#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}",
  ]);

  if (!output) {
    return [];
  }

  return output
    .trim()
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => {
      const [sessionName = "", windows = "0", attached = "0", created = "0"] = line.split("\t");
      return {
        sessionName,
        windowCount: Number(windows) || 0,
        attached: attached === "1",
        createdAtEpochSeconds: Number(created) || 0,
      } satisfies TmuxSessionSummary;
    });
}

export async function inspectTmuxSession(sessionName: string): Promise<TmuxSessionInspection> {
  const summaries = await listTmuxSessions();
  const summary = summaries.find((item) => item.sessionName === sessionName);
  if (!summary) {
    return {
      sessionName,
      windowCount: 0,
      attached: false,
      createdAtEpochSeconds: 0,
      exists: false,
      pane: null,
    };
  }

  const pane = await getPaneSnapshot(getPrimaryTarget(sessionName));

  return {
    ...summary,
    exists: true,
    pane,
  };
}

export async function sendLiteralToTmuxSession(
  sessionName: string,
  text: string,
  options: { enter?: boolean } = {},
): Promise<void> {
  const target = getPrimaryTarget(sessionName);
  await runTmux(["send-keys", "-t", target, "-l", text]);
  if (options.enter ?? true) {
    await runTmux(["send-keys", "-t", target, "Enter"]);
  }
}

export async function prepareClaudeInput(sessionName: string): Promise<void> {
  const target = getPrimaryTarget(sessionName);
  await runTmux(["send-keys", "-t", target, "Escape"]);
  await runTmux(["send-keys", "-t", target, "C-l"]);
  await runTmux(["send-keys", "-t", target, "i"]);
}

export async function sendEnterToTmuxSession(sessionName: string): Promise<void> {
  await runTmux(["send-keys", "-t", getPrimaryTarget(sessionName), "Enter"]);
}

async function gracefulInterruptTmuxSession(sessionName: string): Promise<void> {
  const target = getPrimaryTarget(sessionName);
  await runTmux(["send-keys", "-t", target, "C-c"]);
  await new Promise<void>((resolve) => setTimeout(resolve, 500));
  await runTmux(["send-keys", "-t", target, "C-c"]);
}

/**
 * Quit Claude Code running in a tmux session without destroying the session.
 * Sends Ctrl+C twice (Claude's quit sequence) and waits for the process to exit.
 * The tmux session remains alive and FREE for reuse.
 */
export async function killTmuxSession(sessionName: string): Promise<void> {
  if (!(await tmuxSessionExists(sessionName))) {
    return;
  }

  const inspection = await inspectTmuxSession(sessionName);
  if (inspection.pane?.currentCommand === "claude") {
    await gracefulInterruptTmuxSession(sessionName);
    await new Promise<void>((resolve) => setTimeout(resolve, 750));
  }
}

export async function createDetachedTmuxSession(
  sessionName: string,
  cwd: string,
  command: string,
): Promise<void> {
  await runTmux(["new-session", "-d", "-s", sessionName, "-c", cwd, command]);
}

export async function ensureUniqueTmuxSessionName(baseName: string): Promise<string> {
  const cleanBase = baseName.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "autonoma";
  let candidate = cleanBase;
  let suffix = 2;

  while (await tmuxSessionExists(candidate)) {
    candidate = `${cleanBase}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}
