import type http from "node:http";
import type { PiHistoryItem, PiHistoryResponse } from "../../contracts/index.ts";
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
      return body.items;
    }
  }

  if (!snapshot.sessionFile) return [];

  const body = await readPiHistory(snapshot.sessionId, snapshot.sessionFile, historyMode);
  return body.items;
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
    for (const session of allSessions) {
      const items = await readSessionHistory(session, historyMode);
      if (session.workstreamName) {
        for (const item of items) {
          if (item.kind === "message") {
            item.workstreamName = session.workstreamName;
          }
        }
      }
      allItems.push(...items);
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
