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

  // Abort the current in-flight Pi turn; the queue pump will pick up the next item naturally
  managed.session.abort?.();

  // Send Escape to each linked CC session — graceful interrupt without killing the process
  const ccSessions = getActiveManagedSessionsByPi(runtime.blackboard, piSessionId);
  let signaledSessions = 0;
  for (const ccSession of ccSessions) {
    if (ccSession.tmuxSession) {
      await sendEscapeToTmuxSession(ccSession.tmuxSession);
      signaledSessions++;
    }
  }

  runtime.log(
    `pi-session interrupt: aborted turn for ${piSessionId}, signaled ${signaledSessions} CC session(s)`,
  );

  const body: PiSessionInterruptResponse = { ok: true, piSessionId, signaledSessions };
  return sendJson(res, 200, body);
}
