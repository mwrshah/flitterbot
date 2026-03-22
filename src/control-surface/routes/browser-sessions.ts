import type http from "node:http";
import { getSessionById } from "../../blackboard/queries/sessions.ts";
import { inspectTmuxSession } from "../../claude-sessions/tmux.ts";
import type { SessionDetailResponse, SessionsListResponse } from "../../contracts/index.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { sendJson } from "./_shared.ts";

export async function handleBrowserSessionsRoute(
  runtime: ControlSurfaceRuntime,
  _request: http.IncomingMessage,
  response: http.ServerResponse,
) {
  const body: SessionsListResponse = {
    items: runtime.getSessionList(),
  };
  return sendJson(response, 200, body);
}

export async function handleBrowserSessionDetailRoute(
  runtime: ControlSurfaceRuntime,
  _request: http.IncomingMessage,
  response: http.ServerResponse,
  sessionId: string,
) {
  const session = getSessionById(runtime.blackboard, sessionId);
  if (!session) {
    return sendJson(response, 404, { ok: false, error: "session not found" });
  }

  const tmux = session.tmuxSession ? await inspectTmuxSession(session.tmuxSession) : null;
  const body: SessionDetailResponse = {
    session,
    tmux,
  };
  return sendJson(response, 200, body);
}
