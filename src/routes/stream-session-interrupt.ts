import type http from "node:http";
import { getActiveManagedSessionsByPi } from "../blackboard/query-sessions.ts";
import { sendEscapeToTmuxSession } from "../claude-sessions/tmux.ts";
import type { StreamSessionInterruptResponse } from "../contracts/index.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { requireBearer, sendJson } from "./_shared.ts";

export async function handleStreamSessionInterruptRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  streamSessionId: string,
): Promise<void> {
  if (!requireBearer(req, runtime.config.controlSurfaceToken)) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }

  const managed = runtime.sessionManager.getByStreamSessionId(streamSessionId);
  if (!managed) {
    const body: StreamSessionInterruptResponse = { ok: false, error: "streams session not found" };
    return sendJson(res, 404, body);
  }

  // Abort the current in-flight streams turn; the queue pump will pick up the next item naturally
  let bashAborted = false;
  if (managed.session) {
    try {
      managed.session.abort?.();
    } catch {
      // Non-fatal — continue to bash abort and CC signals
    }
    try {
      if (managed.session.isBashRunning) {
        managed.session.abortBash?.();
        bashAborted = true;
      }
    } catch {
      // Non-fatal — continue to CC signals
    }
  }

  // Send Escape to each linked CC session — graceful interrupt without killing the process
  const ccSessions = getActiveManagedSessionsByPi(runtime.blackboard, streamSessionId);
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
    `stream-session interrupt: aborted turn for ${streamSessionId}${bashAborted ? " (bash killed)" : ""}, signaled ${signaledSessions} CC session(s)`,
  );

  const body: StreamSessionInterruptResponse = { ok: true, streamSessionId, signaledSessions };
  return sendJson(res, 200, body);
}
