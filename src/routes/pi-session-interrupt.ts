import type http from "node:http";
import { getActiveManagedSessionsByPi } from "../blackboard/query-sessions.ts";
import { sendEscapeToTmuxSession } from "../claude-sessions/tmux.ts";
import type { PiSessionInterruptResponse } from "../contracts/index.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { requireBearer, sendJson } from "./_shared.ts";

export async function handlePiSessionInterruptRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  piSessionId: string,
): Promise<void> {
  if (!requireBearer(req, runtime.config.controlSurfaceToken)) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }

  const managed = runtime.sessionManager.getByPiSessionId(piSessionId);
  if (!managed) {
    const body: PiSessionInterruptResponse = { ok: false, error: "pi session not found" };
    return sendJson(res, 404, body);
  }

  // Abort the current in-flight streams turn; the queue pump will pick up the next item naturally
  let bashAborted = false;
  const session = managed.runtime?.session;
  if (session) {
    try {
      session.abort?.();
    } catch {
      // Non-fatal — continue to bash abort and CC signals
    }
    try {
      if (session.isBashRunning) {
        session.abortBash?.();
        bashAborted = true;
      }
    } catch {
      // Non-fatal — continue to CC signals
    }
  }

  // Send Escape to each linked CC session — graceful interrupt without killing the process
  const ccSessions = getActiveManagedSessionsByPi(runtime.blackboard, piSessionId);
  let signaledSessions = 0;
  for (const ccSession of ccSessions) {
    if (ccSession.tmuxSession) {
      try {
        await sendEscapeToTmuxSession(ccSession.tmuxSession);
        signaledSessions++;
      } catch {
        // Stale tmux session reference — skip silently
      }
    }
  }

  runtime.log(
    `pi-session interrupt: aborted turn for ${piSessionId}${bashAborted ? " (bash killed)" : ""}, signaled ${signaledSessions} CC session(s)`,
  );

  const body: PiSessionInterruptResponse = { ok: true, piSessionId, signaledSessions };
  return sendJson(res, 200, body);
}
