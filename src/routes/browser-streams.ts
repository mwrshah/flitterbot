import type http from "node:http";
import { getInputSurfaceHistory } from "../blackboard/query-messages.ts";
import {
  CLOSED_STREAM_LOOKBACK_HOURS,
  getStreamPiSessionId,
  listClosedStreams,
} from "../blackboard/query-streams.ts";
import type {
  ChatTimelineItem,
  ChatTimelineMessage,
  StreamsHistoryLimit,
  StreamsHistoryResponse,
} from "../contracts/index.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import {
  decodeHistoryCursor,
  type HistoryCursor,
  parseVisibleRowLimit,
  readStreamsHistory,
  readStreamsHistoryFromSession,
  takePageEndingBeforeCursor,
} from "../streams/history.ts";
import type { ManagedPiSession } from "../streams/pi-session-manager.ts";
import { enrichTimelineToolDisplays } from "../streams/tool-display.ts";
import { sendJson } from "./_shared.ts";

function readSessionHistory(
  managed: ManagedPiSession,
  historyMode: "input" | "agent",
): ChatTimelineItem[] {
  const snapshot = managed.state.getSnapshot();
  if (!snapshot.piSessionId) return [];

  let items: ChatTimelineItem[];

  const session = managed.runtime?.session;
  if (session && session.sessionId === snapshot.piSessionId) {
    const liveItems = readStreamsHistoryFromSession(session.sessionManager, historyMode);
    if (liveItems.length > 0 || !snapshot.sessionFile) {
      items = liveItems;
    } else if (snapshot.sessionFile) {
      items = readStreamsHistory(snapshot.piSessionId, snapshot.sessionFile, historyMode);
    } else {
      return [];
    }
  } else if (snapshot.sessionFile) {
    items = readStreamsHistory(snapshot.piSessionId, snapshot.sessionFile, historyMode);
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
  const visibleRowLimit = parseVisibleRowLimit(url.searchParams.get("limit"));
  const beforeParam = url.searchParams.get("before");

  let cursor: HistoryCursor | null = null;
  if (beforeParam !== null && beforeParam !== "") {
    cursor = decodeHistoryCursor(beforeParam);
    if (!cursor) return sendJson(response, 400, { error: "Invalid cursor" });
  }

  try {
    return await handleBrowserStreamsHistoryRouteInner(
      runtime,
      response,
      historyMode,
      piSessionId,
      visibleRowLimit,
      cursor,
    );
  } catch (err) {
    const ctx = piSessionId ? `piSessionId=${piSessionId}` : "aggregated";
    console.error("streams-history route error (%s, mode=%s): %O", ctx, historyMode, err);
    const body: StreamsHistoryResponse = { items: [] };
    return sendJson(response, 500, body);
  }
}

async function handleBrowserStreamsHistoryRouteInner(
  runtime: ControlSurfaceRuntime,
  response: http.ServerResponse,
  historyMode: "input" | "agent",
  piSessionId: string | null,
  visibleRowLimit: StreamsHistoryLimit,
  cursor: HistoryCursor | null,
) {
  if (historyMode === "input" && !piSessionId) {
    const piSessionIds: string[] = [];
    const defaultPiSessionId = runtime.sessionManager.getDefault()?.piSessionId;
    if (defaultPiSessionId) piSessionIds.push(defaultPiSessionId);
    for (const orch of runtime.sessionManager.listStreamSessions()) {
      if (orch.piSessionId) piSessionIds.push(orch.piSessionId);
    }
    const closedStreams = listClosedStreams(
      runtime.blackboard,
      CLOSED_STREAM_LOOKBACK_HOURS,
      false,
    );
    for (const ws of closedStreams) {
      const wsSessionId = getStreamPiSessionId(runtime.blackboard, ws.id);
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

    const page = takePageEndingBeforeCursor(items, visibleRowLimit, cursor);
    if (!page) return sendJson(response, 400, { error: "Invalid cursor" });
    const body: StreamsHistoryResponse = {
      items: page.items,
      olderPageCursor: page.olderPageCursor,
    };
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
        const historyPosition = !cursor ? runtime.wsHub.historyPosition(piSessionId) : undefined;
        const diskItems = readStreamsHistory(piSessionId, row.session_file, historyMode);
        if (diskItems.length > 0) {
          const formatter =
            runtime.sessionManager.toolDisplayCache.formatterForPiSession(piSessionId);
          const enriched = enrichTimelineToolDisplays(diskItems, formatter);
          const page = takePageEndingBeforeCursor(enriched, visibleRowLimit, cursor);
          if (!page) return sendJson(response, 400, { error: "Invalid cursor" });
          const body: StreamsHistoryResponse = {
            ...(historyPosition ? { historyPosition } : {}),
            items: page.items,
            olderPageCursor: page.olderPageCursor,
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

  const snapshot = targetSession.state.getSnapshot();
  const historyPosition =
    !cursor && snapshot.piSessionId
      ? runtime.wsHub.historyPosition(snapshot.piSessionId)
      : undefined;
  let items = readSessionHistory(targetSession, historyMode);
  if (targetSession.streamName) {
    for (const item of items) {
      if (item.kind === "message") {
        item.streamName = targetSession.streamName;
      }
    }
  }
  if (snapshot.piSessionId) {
    const formatter = runtime.sessionManager.toolDisplayCache.formatterForPiSession(
      snapshot.piSessionId,
    );
    items = enrichTimelineToolDisplays(items, formatter);
  }
  const page = takePageEndingBeforeCursor(items, visibleRowLimit, cursor);
  if (!page) return sendJson(response, 400, { error: "Invalid cursor" });
  const body: StreamsHistoryResponse = {
    ...(historyPosition ? { historyPosition } : {}),
    ...(!cursor ? { turnQueue: targetSession.queue.getSnapshot() } : {}),
    items: page.items,
    olderPageCursor: page.olderPageCursor,
  };
  return sendJson(response, 200, body);
}
