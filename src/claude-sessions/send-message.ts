import type {
  SendMessageToTmuxSessionResult as DirectInjectionResult,
  TmuxUiState,
} from "../contracts/index.ts";
import {
  inspectTmuxSession,
  prepareClaudeInput,
  sendEnterToTmuxSession,
  sendLiteralToTmuxSession,
} from "./tmux.ts";

function snapshotMeaningfullyChanged(before: string, after: string): boolean {
  return before.replace(/\s+/g, " ").trim() !== after.replace(/\s+/g, " ").trim();
}

async function currentUiState(sessionName: string): Promise<TmuxUiState> {
  const inspection = await inspectTmuxSession(sessionName);
  if (!inspection.exists) {
    return "MISSING";
  }
  return inspection.pane?.uiState ?? "MISSING";
}

export async function sendMessageToClaudeSession(
  sessionName: string,
  prompt: string,
  options: { verifyInference?: boolean; maxRetries?: number; settleMs?: number } = {},
): Promise<DirectInjectionResult> {
  const verifyInference = options.verifyInference ?? true;
  const maxRetries = options.maxRetries ?? 2;
  const settleMs = options.settleMs ?? 2000;

  const before = await inspectTmuxSession(sessionName);
  if (!before.exists) {
    return { ok: false, reason: "tmux_session_missing", uiState: "MISSING" };
  }

  if (!before.pane || before.pane.currentCommand !== "claude") {
    return { ok: false, reason: "no_live_claude", uiState: before.pane?.uiState ?? "NO_CLAUDE" };
  }

  await prepareClaudeInput(sessionName);
  await sendLiteralToTmuxSession(sessionName, prompt, { enter: false });
  await sendEnterToTmuxSession(sessionName);

  if (!verifyInference) {
    return {
      ok: true,
      delivery: "tmux_send_keys",
      retries: 0,
      uiState: await currentUiState(sessionName),
    };
  }

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, settleMs));

    const after = await inspectTmuxSession(sessionName);
    const uiState = after.pane?.uiState ?? (after.exists ? "NO_CLAUDE" : "MISSING");
    if (uiState === "INFERRING") {
      return { ok: true, delivery: "tmux_send_keys", retries: attempt, uiState };
    }

    if (snapshotMeaningfullyChanged(before.pane?.capture ?? "", after.pane?.capture ?? "")) {
      return { ok: true, delivery: "tmux_send_keys", retries: attempt, uiState };
    }

    if (attempt < maxRetries) {
      await sendEnterToTmuxSession(sessionName);
    }
  }

  return {
    ok: false,
    reason: "message_not_acknowledged",
    retries: maxRetries,
    uiState: await currentUiState(sessionName),
  };
}
