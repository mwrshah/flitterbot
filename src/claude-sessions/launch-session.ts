import { randomUUID } from "node:crypto";
import path from "node:path";
import type { LaunchClaudeSessionInput, LaunchClaudeSessionResult } from "../contracts/index.ts";
import { sendMessageToClaudeSession } from "./send-message.ts";
import { createDetachedTmuxSession, ensureUniqueTmuxSessionName } from "./tmux.ts";

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function slugifySessionName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function buildSessionName(input: LaunchClaudeSessionInput): string {
  const fallback = `autonoma-${randomUUID().slice(0, 8)}`;
  if (input.sessionName?.trim()) {
    return slugifySessionName(input.sessionName) || fallback;
  }

  const base = input.taskDescription?.trim() || path.basename(input.cwd) || "claude";
  const slug = slugifySessionName(base);
  return slug ? `auto-${slug}` : fallback;
}

function buildClaudeCommand(input: LaunchClaudeSessionInput, tmuxSession: string): string {
  const envPairs: Array<[string, string]> = [
    ["AUTONOMA_AGENT_MANAGED", "1"],
    ["AUTONOMA_TMUX_SESSION", tmuxSession],
    ["AUTONOMA_TASK_DESCRIPTION", input.taskDescription ?? ""],
    ["AUTONOMA_TODOIST_TASK_ID", input.todoistTaskId ?? ""],
    ["AUTONOMA_PI_SESSION_ID", input.piSessionId ?? ""],
    ["AUTONOMA_WORKSTREAM_ID", input.workstreamId ?? ""],
  ];

  const envPrefix = envPairs.map(([key, value]) => `${key}=${shellEscape(value)}`).join(" ");
  const claudeCommand = (input.claudeCommand?.trim() || "claude").trim();
  const extraArgsList = input.extraArgs ?? [];
  const extraArgs = extraArgsList.map(shellEscape).join(" ");
  const argsSuffix = extraArgs ? ` ${extraArgs}` : "";
  const dangerousFlag = "--dangerously-skip-permissions";
  const hasDangerousFlag = claudeCommand.includes(dangerousFlag) || extraArgsList.includes(dangerousFlag);
  const permissionSuffix = hasDangerousFlag ? "" : ` ${dangerousFlag}`;
  return `env ${envPrefix} ${claudeCommand}${permissionSuffix}${argsSuffix}`;
}

export async function launchClaudeSession(input: LaunchClaudeSessionInput): Promise<LaunchClaudeSessionResult> {
  const tmuxSession = await ensureUniqueTmuxSessionName(buildSessionName(input));
  const command = buildClaudeCommand(input, tmuxSession);

  await createDetachedTmuxSession(tmuxSession, input.cwd, command);
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const delivery = await sendMessageToClaudeSession(tmuxSession, input.prompt, {
    verifyInference: true,
    maxRetries: 2,
    settleMs: 2000,
  });

  if (!delivery.ok) {
    throw new Error(`Claude launched in tmux session ${tmuxSession}, but initial prompt delivery failed: ${(delivery as { reason?: string }).reason}`);
  }

  return {
    tmuxSession,
    cwd: input.cwd,
    delivery: "tmux_send_keys",
  };
}
