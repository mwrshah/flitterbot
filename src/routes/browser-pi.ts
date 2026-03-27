import type http from "node:http";
import { getInputSurfaceHistory } from "../blackboard/query-messages.ts";
import {
  getLatestPiSessionId,
  listRecentlyClosedWorkstreams,
} from "../blackboard/query-workstreams.ts";
import type { ChatTimelineItem, ChatTimelineMessage, PiHistoryResponse } from "../contracts/index.ts";
import { readPiHistory, readPiHistoryFromMessages } from "../pi/history.ts";
import type { ManagedPiSession } from "../pi/session-manager.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { sendJson } from "./_shared.ts";

async function readSessionHistory(
  managed: ManagedPiSession,
  historyMode: "input" | "agent",
): Promise<ChatTimelineItem[]> {
  const snapshot = managed.state.getSnapshot();
  if (!snapshot.sessionId) return [];

  let items: ChatTimelineItem[];

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

  try {
    return await handleBrowserPiHistoryRouteInner(runtime, response, historyMode, piSessionId);
  } catch (err) {
    const ctx = piSessionId ? `piSessionId=${piSessionId}` : "aggregated";
    console.error("pi-history route error (%s, mode=%s): %O", ctx, historyMode, err);
    const body: PiHistoryResponse = { sessionId: piSessionId, sessionFile: null, items: [] };
    return sendJson(response, 500, body);
  }
}

async function handleBrowserPiHistoryRouteInner(
  runtime: ControlSurfaceRuntime,
  response: http.ServerResponse,
  historyMode: "input" | "agent",
  piSessionId: string | null,
) {
  // Input surface with no specific session — read from the messages table
  if (historyMode === "input" && !piSessionId) {
    // Collect all relevant pi_session_ids: default + active orchestrators + recently-closed workstreams
    const piSessionIds: string[] = [];
    const defaultPiSessionId = runtime.sessionManager.getDefault()?.piSessionId;
    if (defaultPiSessionId) piSessionIds.push(defaultPiSessionId);
    for (const orch of runtime.sessionManager.listOrchestrators()) {
      if (orch.piSessionId) piSessionIds.push(orch.piSessionId);
    }
    // Include closed workstreams (24h) — look up their pi_session_ids
    const closedWorkstreams = listRecentlyClosedWorkstreams(runtime.blackboard, 24);
    for (const ws of closedWorkstreams) {
      const wsSessionId = getLatestPiSessionId(runtime.blackboard, ws.id);
      if (wsSessionId && !piSessionIds.includes(wsSessionId)) piSessionIds.push(wsSessionId);
    }
    const rows = getInputSurfaceHistory(runtime.blackboard, piSessionIds);
    const items: ChatTimelineItem[] = rows.map((row): ChatTimelineMessage => ({
      id: row.id,
      kind: "message",
      role: row.direction === "inbound" ? "user" : "assistant",
      content: row.content,
      source: row.source,
      workstreamId: row.workstream_id ?? undefined,
      workstreamName: row.workstream_name ?? undefined,
      createdAt: row.created_at,
    }));

    const body: PiHistoryResponse = { sessionId: null, sessionFile: null, items };
    return sendJson(response, 200, body);
  }

  // Specific session or agent mode — existing single-session path
  const targetSession = piSessionId
    ? runtime.sessionManager.getByPiSessionId(piSessionId)
    : runtime.sessionManager.getDefault();

  if (!targetSession) {
    // Session not in memory — fall back to reading history from disk (e.g. closed workstreams)
    if (piSessionId) {
      const row = runtime.blackboard
        .prepare("SELECT session_file FROM pi_sessions WHERE pi_session_id = ?")
        .get(piSessionId) as { session_file: string | null } | undefined;
      if (row?.session_file) {
        const diskBody = await readPiHistory(piSessionId, row.session_file, historyMode);
        if (diskBody.items.length > 0) {
          const body: PiHistoryResponse = {
            sessionId: piSessionId,
            sessionFile: row.session_file,
            items: diskBody.items,
          };
          return sendJson(response, 200, body);
        }
        // DB row exists but file missing or empty — stale session from a previous runtime
        console.warn(
          "pi-history: session in DB but no history on disk (piSessionId=%s, file=%s)",
          piSessionId,
          row.session_file,
        );
      }
    }
    console.warn(
      "pi-history: session not found (piSessionId=%s, mode=%s)",
      piSessionId ?? "none",
      historyMode,
    );
    return sendJson(response, 404, { error: "Session not found" });
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
