import type http from "node:http";
import type { PiHistoryItem, PiHistoryResponse } from "../../contracts/index.ts";
import {
  getLatestPiSessionId,
  listRecentlyClosedWorkstreams,
} from "../../blackboard/queries/workstreams.ts";
import { readPiHistory, readPiHistoryFromMessages } from "../pi/history.ts";
import type { ManagedPiSession } from "../pi/session-manager.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { sendJson } from "./_shared.ts";

async function readSessionHistory(
  managed: ManagedPiSession,
  historyMode: "input" | "agent",
): Promise<PiHistoryItem[]> {
  const snapshot = managed.state.getSnapshot();
  if (!snapshot.sessionId) return [];

  let items: PiHistoryItem[];

  if (
    managed.session?.sessionId === snapshot.sessionId &&
    Array.isArray(managed.session.messages)
  ) {
    const body = readPiHistoryFromMessages(
      snapshot.sessionId,
      snapshot.sessionFile ?? null,
      managed.session.messages,
      historyMode,
    );
    if (body.items.length > 0 || !snapshot.sessionFile) {
      items = body.items;
    } else if (snapshot.sessionFile) {
      const fileBody = await readPiHistory(snapshot.sessionId, snapshot.sessionFile, historyMode);
      items = fileBody.items;
    } else {
      return [];
    }
  } else if (snapshot.sessionFile) {
    const body = await readPiHistory(snapshot.sessionId, snapshot.sessionFile, historyMode);
    items = body.items;
  } else {
    return [];
  }

  // When a turn is in progress, suppress the trailing assistant message —
  // it's an intermediate response that will change once tool calls finish.
  if (historyMode === "input" && snapshot.busy && items.length > 0) {
    const last = items[items.length - 1]!;
    if (last.kind === "message" && last.role === "assistant") {
      items = items.slice(0, -1);
    }
  }

  return items;
}

export async function handleBrowserPiHistoryRoute(
  runtime: ControlSurfaceRuntime,
  request: http.IncomingMessage,
  response: http.ServerResponse,
) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const historyMode = url.searchParams.get("surface") === "input" ? "input" : "agent";
  const piSessionId = url.searchParams.get("piSessionId");

  // When input surface requests history with no specific session, aggregate all
  if (historyMode === "input" && !piSessionId) {
    const allSessions: ManagedPiSession[] = [];
    try {
      allSessions.push(runtime.sessionManager.getDefault());
    } catch {
      /* no default yet */
    }
    allSessions.push(...runtime.sessionManager.listOrchestrators());

    const allItems: PiHistoryItem[] = [];
    const processedSessionIds = new Set<string>();

    for (const session of allSessions) {
      const snapshot = session.state.getSnapshot();
      if (snapshot.sessionId) processedSessionIds.add(snapshot.sessionId);

      const items = await readSessionHistory(session, historyMode);
      const sessionPrefix = snapshot.sessionId ?? "default";
      for (const item of items) {
        item.id = `${sessionPrefix}:${item.id}`;
        if (session.workstreamName && item.kind === "message") {
          item.workstreamName = session.workstreamName;
        }
      }
      allItems.push(...items);
    }

    // Include history from recently-closed workstreams
    const closedWorkstreams = listRecentlyClosedWorkstreams(runtime.blackboard, 24);
    for (const ws of closedWorkstreams) {
      const piSessionId = getLatestPiSessionId(runtime.blackboard, ws.id);
      if (!piSessionId || processedSessionIds.has(piSessionId)) continue;
      processedSessionIds.add(piSessionId);

      const row = runtime.blackboard
        .prepare("SELECT session_file FROM pi_sessions WHERE pi_session_id = ?")
        .get(piSessionId) as { session_file: string | null } | undefined;
      if (!row?.session_file) continue;

      const body = await readPiHistory(piSessionId, row.session_file, historyMode);
      for (const item of body.items) {
        item.id = `${piSessionId}:${item.id}`;
        if (item.kind === "message") {
          item.workstreamName = ws.name;
        }
      }
      allItems.push(...body.items);
    }

    allItems.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const body: PiHistoryResponse = { sessionId: null, sessionFile: null, items: allItems };
    return sendJson(response, 200, body);
  }

  // Specific session or agent mode — existing single-session path
  const targetSession = piSessionId
    ? runtime.sessionManager.getByPiSessionId(piSessionId)
    : runtime.sessionManager.getDefault();

  if (!targetSession) {
    const body: PiHistoryResponse = { sessionId: piSessionId, sessionFile: null, items: [] };
    return sendJson(response, 200, body);
  }

  const items = await readSessionHistory(targetSession, historyMode);
  if (targetSession.workstreamName) {
    for (const item of items) {
      if (item.kind === "message") {
        item.workstreamName = targetSession.workstreamName;
      }
    }
  }
  const snapshot = targetSession.state.getSnapshot();
  const body: PiHistoryResponse = {
    sessionId: snapshot.sessionId ?? null,
    sessionFile: snapshot.sessionFile ?? null,
    items,
  };
  return sendJson(response, 200, body);
}
