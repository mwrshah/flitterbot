import type { BlackboardDatabase } from "../blackboard/db.ts";
import { getInjectionEligibility, getSessionById } from "../blackboard/query-sessions.ts";
import { sendMessageToClaudeSession } from "../claude-sessions/send-message.ts";
import { inspectTmuxSession, tmuxSessionExists } from "../claude-sessions/tmux.ts";
import type { AutonomaConfig } from "../config/load-config.ts";
import type {
  DirectSessionMessageFailureReason,
  DirectSessionMessageResponse,
} from "../contracts/index.ts";

type SessionControlContext = {
  blackboard: BlackboardDatabase;
  config: Pick<AutonomaConfig, "stallMinutes" | "toolTimeoutMinutes">;
};

export async function directSessionMessage(
  context: SessionControlContext,
  sessionId: string,
  text: string,
): Promise<DirectSessionMessageResponse> {
  const session = getSessionById(context.blackboard, sessionId);
  if (!session) {
    return { ok: false, sessionId, reason: "stale_or_ambiguous" };
  }

  const eligibility = getInjectionEligibility(session, context.config);
  if (!eligibility.ok) {
    return {
      ok: false,
      sessionId,
      busy: eligibility.reason === "busy",
      reason: eligibility.reason as DirectSessionMessageFailureReason,
    };
  }

  const tmuxSession = session.tmuxSession;
  if (!tmuxSession) {
    return { ok: false, sessionId, reason: "no_tmux_session" };
  }

  if (!(await tmuxSessionExists(tmuxSession))) {
    return { ok: false, sessionId, reason: "tmux_session_missing" };
  }

  const inspection = await inspectTmuxSession(tmuxSession);
  if (!inspection.exists || !inspection.pane) {
    return { ok: false, sessionId, reason: "tmux_session_missing" };
  }

  if (inspection.pane.uiState === "INFERRING") {
    return { ok: false, sessionId, busy: true, reason: "busy" };
  }

  if (inspection.pane.uiState !== "IDLE") {
    return { ok: false, sessionId, busy: false, reason: "stale_or_ambiguous" };
  }

  const delivery = await sendMessageToClaudeSession(tmuxSession, text, {
    verifyInference: true,
    maxRetries: 2,
    settleMs: 2000,
  });

  if (!delivery.ok) {
    return {
      ok: false,
      sessionId,
      busy: delivery.uiState === "INFERRING",
      reason: (delivery as { reason?: string }).reason as DirectSessionMessageFailureReason,
    };
  }

  return { ok: true, delivery: "tmux_send_keys", sessionId };
}
