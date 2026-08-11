import type http from "node:http";
import { getActiveManagedSessionsByPi } from "../blackboard/query-sessions.ts";
import type { PiSessionInterruptResponse } from "../contracts/index.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { sendEscapeToTmuxSession } from "../tmux-sessions/tmux.ts";
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

  let interrupt: { bashAborted: boolean } | null;
  try {
    interrupt = await runtime.sessionManager.interruptPiSession(piSessionId);
  } catch (error) {
    const body: PiSessionInterruptResponse = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    return sendJson(res, 409, body);
  }
  if (!interrupt) {
    const body: PiSessionInterruptResponse = { ok: false, error: "pi session not found" };
    return sendJson(res, 404, body);
  }
  const { bashAborted } = interrupt;

  const ccSessions = getActiveManagedSessionsByPi(runtime.blackboard, piSessionId);
  let signaledSessions = 0;
  for (const ccSession of ccSessions) {
    if (ccSession.tmuxSession) {
      try {
        await sendEscapeToTmuxSession(ccSession.tmuxSession);
        signaledSessions++;
      } catch {}
    }
  }

  runtime.log(
    `pi-session interrupt: aborted turn for ${piSessionId}${bashAborted ? " (bash killed)" : ""}, signaled ${signaledSessions} CC session(s)`,
  );

  const body: PiSessionInterruptResponse = { ok: true, piSessionId, signaledSessions };
  return sendJson(res, 200, body);
}
