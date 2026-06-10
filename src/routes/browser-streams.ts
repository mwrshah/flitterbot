import type http from "node:http";
import { getInputSurfaceHistory } from "../blackboard/query-messages.ts";
import {
  getLatestPiSessionId,
  listRecentlyClosedStreams,
  RECENTLY_CLOSED_WINDOW_HOURS,
} from "../blackboard/query-streams.ts";
import type {
  ChatTimelineItem,
  ChatTimelineMessage,
  StreamsHistoryResponse,
} from "../contracts/index.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { readStreamsHistory, readStreamsHistoryFromSession } from "../streams/history.ts";
import type { ManagedPiSession } from "../streams/pi-session-manager.ts";
import { enrichTimelineToolDisplays } from "../streams/tool-display.ts";
import { sendJson } from "./_shared.ts";

async function readSessionHistory(
  managed: ManagedPiSession,
  historyMode: "input" | "agent",
): Promise<ChatTimelineItem[]> {
  const snapshot = managed.state.getSnapshot();
  if (!snapshot.piSessionId) return [];

  let items: ChatTimelineItem[];

  const session = managed.runtime?.session;
  if (session && session.sessionId === snapshot.piSessionId) {
    const body = readStreamsHistoryFromSession(
      snapshot.piSessionId,
      session.sessionManager,
      historyMode,
    );
    if (body.items.length > 0 || !snapshot.sessionFile) {
      items = body.items;
    } else if (snapshot.sessionFile) {
      const fileBody = readStreamsHistory(snapshot.piSessionId, snapshot.sessionFile, historyMode);
      items = fileBody.items;
    } else {
      return [];
    }
  } else if (snapshot.sessionFile) {
    const body = readStreamsHistory(snapshot.piSessionId, snapshot.sessionFile, historyMode);
    items = body.items;
  } else {
    return [];
  }

  if (historyMode === "input" && snapshot.busy && items.length > 0) {
    const last = items[items.length - 1]!;
    if (last.kind === "message" && last.role === "assistant") {
      items = items.slice(0, -1);
    }
  }

  return items;
}

export async function handleBrowserStreamsHistoryRoute(
  runtime: ControlSurfaceRuntime,
  request: http.IncomingMessage,
  response: http.ServerResponse,
) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const historyMode = url.searchParams.get("surface") === "input" ? "input" : "agent";
  const piSessionId = url.searchParams.get("piSessionId");

  try {
    return await handleBrowserStreamsHistoryRouteInner(runtime, response, historyMode, piSessionId);
  } catch (err) {
    const ctx = piSessionId ? `piSessionId=${piSessionId}` : "aggregated";
    console.error("streams-history route error (%s, mode=%s): %O", ctx, historyMode, err);
    const body: StreamsHistoryResponse = {
      piSessionId: piSessionId,
      sessionFile: null,
      items: [],
    };
    return sendJson(response, 500, body);
  }
}

async function handleBrowserStreamsHistoryRouteInner(
  runtime: ControlSurfaceRuntime,
  response: http.ServerResponse,
  historyMode: "input" | "agent",
  piSessionId: string | null,
) {
  if (historyMode === "input" && !piSessionId) {
    const piSessionIds: string[] = [];
    const defaultPiSessionId = runtime.sessionManager.getDefault()?.piSessionId;
    if (defaultPiSessionId) piSessionIds.push(defaultPiSessionId);
    for (const orch of runtime.sessionManager.listStreamSessions()) {
      if (orch.piSessionId) piSessionIds.push(orch.piSessionId);
    }
    const closedStreams = listRecentlyClosedStreams(
      runtime.blackboard,
      RECENTLY_CLOSED_WINDOW_HOURS,
    );
    for (const ws of closedStreams) {
      const wsSessionId = getLatestPiSessionId(runtime.blackboard, ws.id);
      if (wsSessionId && !piSessionIds.includes(wsSessionId)) piSessionIds.push(wsSessionId);
    }
    const rows = getInputSurfaceHistory(runtime.blackboard, piSessionIds);
    const items: ChatTimelineItem[] = rows.map(
      (row): ChatTimelineMessage => ({
        id: row.id,
        kind: "message",
        role: row.direction === "inbound" ? "user" : "assistant",
        content: row.content,
        source: row.source,
        streamId: row.stream_id ?? undefined,
        streamName: row.stream_name ?? undefined,
        createdAt: row.created_at,
      }),
    );

    const body: StreamsHistoryResponse = { piSessionId: null, sessionFile: null, items };
    return sendJson(response, 200, body);
  }

  const targetSession = piSessionId
    ? runtime.sessionManager.getByPiSessionId(piSessionId)
    : runtime.sessionManager.getDefault();

  if (!targetSession) {
    if (piSessionId) {
      const row = runtime.blackboard
        .prepare("SELECT session_file FROM pi_sessions WHERE pi_session_id = ?")
        .get(piSessionId) as { session_file: string | null } | undefined;
      if (row?.session_file) {
        const diskBody = readStreamsHistory(piSessionId, row.session_file, historyMode);
        if (diskBody.items.length > 0) {
          const formatter =
            runtime.sessionManager.toolDisplayCache.formatterForPiSession(piSessionId);
          const enriched = enrichTimelineToolDisplays(diskBody.items, formatter);
          const body: StreamsHistoryResponse = {
            piSessionId: piSessionId,
            sessionFile: row.session_file,
            items: enriched,
          };
          return sendJson(response, 200, body);
        }
        console.warn(
          "streams-history: session in DB but no history on disk (piSessionId=%s, file=%s)",
          piSessionId,
          row.session_file,
        );
      }
    }
    console.warn(
      "streams-history: session not found (piSessionId=%s, mode=%s)",
      piSessionId ?? "none",
      historyMode,
    );
    return sendJson(response, 404, { error: "Session not found" });
  }

  let items = await readSessionHistory(targetSession, historyMode);
  if (targetSession.streamName) {
    for (const item of items) {
      if (item.kind === "message") {
        item.streamName = targetSession.streamName;
      }
    }
  }
  const snapshot = targetSession.state.getSnapshot();
  if (snapshot.piSessionId) {
    const formatter = runtime.sessionManager.toolDisplayCache.formatterForPiSession(
      snapshot.piSessionId,
    );
    items = enrichTimelineToolDisplays(items, formatter);
  }
  const body: StreamsHistoryResponse = {
    piSessionId: snapshot.piSessionId ?? null,
    sessionFile: snapshot.sessionFile ?? null,
    items,
  };
  return sendJson(response, 200, body);
}
