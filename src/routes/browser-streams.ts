import type http from "node:http";
import { getInputSurfaceHistory } from "../blackboard/query-messages.ts";
import {
  getLatestStreamSessionId,
  listRecentlyClosedStreams,
} from "../blackboard/query-streams.ts";
import type {
  ChatTimelineItem,
  ChatTimelineMessage,
  StreamsHistoryResponse,
} from "../contracts/index.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { readStreamsHistory, readStreamsHistoryFromMessages } from "../streams/history.ts";
import type { ManagedStreamSession } from "../streams/session-manager.ts";
import { sendJson } from "./_shared.ts";

async function readSessionHistory(
  managed: ManagedStreamSession,
  historyMode: "input" | "agent",
): Promise<ChatTimelineItem[]> {
  const snapshot = managed.state.getSnapshot();
  if (!snapshot.sessionId) return [];

  let items: ChatTimelineItem[];

  if (
    managed.session?.sessionId === snapshot.sessionId &&
    Array.isArray(managed.session.messages)
  ) {
    const body = readStreamsHistoryFromMessages(
      snapshot.sessionId,
      snapshot.sessionFile ?? null,
      managed.session.messages,
      historyMode,
    );
    if (body.items.length > 0 || !snapshot.sessionFile) {
      items = body.items;
    } else if (snapshot.sessionFile) {
      const fileBody = await readStreamsHistory(
        snapshot.sessionId,
        snapshot.sessionFile,
        historyMode,
      );
      items = fileBody.items;
    } else {
      return [];
    }
  } else if (snapshot.sessionFile) {
    const body = await readStreamsHistory(snapshot.sessionId, snapshot.sessionFile, historyMode);
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

export async function handleBrowserStreamsHistoryRoute(
  runtime: ControlSurfaceRuntime,
  request: http.IncomingMessage,
  response: http.ServerResponse,
) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const historyMode = url.searchParams.get("surface") === "input" ? "input" : "agent";
  const streamSessionId = url.searchParams.get("streamSessionId");

  try {
    return await handleBrowserStreamsHistoryRouteInner(
      runtime,
      response,
      historyMode,
      streamSessionId,
    );
  } catch (err) {
    const ctx = streamSessionId ? `streamSessionId=${streamSessionId}` : "aggregated";
    console.error("streams-history route error (%s, mode=%s): %O", ctx, historyMode, err);
    const body: StreamsHistoryResponse = {
      sessionId: streamSessionId,
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
  streamSessionId: string | null,
) {
  // Surface with no specific session — read from the messages table
  if (historyMode === "input" && !streamSessionId) {
    // Collect all relevant stream_session_ids: default + active orchestrators + recently-closed streams
    const streamSessionIds: string[] = [];
    const defaultStreamSessionId = runtime.sessionManager.getDefault()?.streamSessionId;
    if (defaultStreamSessionId) streamSessionIds.push(defaultStreamSessionId);
    for (const orch of runtime.sessionManager.listOrchestrators()) {
      if (orch.streamSessionId) streamSessionIds.push(orch.streamSessionId);
    }
    // Include closed streams (24h) — look up their stream_session_ids
    const closedStreams = listRecentlyClosedStreams(runtime.blackboard, 24);
    for (const ws of closedStreams) {
      const wsSessionId = getLatestStreamSessionId(runtime.blackboard, ws.id);
      if (wsSessionId && !streamSessionIds.includes(wsSessionId))
        streamSessionIds.push(wsSessionId);
    }
    const rows = getInputSurfaceHistory(runtime.blackboard, streamSessionIds);
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

    const body: StreamsHistoryResponse = { sessionId: null, sessionFile: null, items };
    return sendJson(response, 200, body);
  }

  // Specific session or agent mode — existing single-session path
  const targetSession = streamSessionId
    ? runtime.sessionManager.getByStreamSessionId(streamSessionId)
    : runtime.sessionManager.getDefault();

  if (!targetSession) {
    // Session not in memory — fall back to reading history from disk (e.g. closed streams)
    if (streamSessionId) {
      const row = runtime.blackboard
        .prepare("SELECT session_file FROM stream_sessions WHERE stream_session_id = ?")
        .get(streamSessionId) as { session_file: string | null } | undefined;
      if (row?.session_file) {
        const diskBody = await readStreamsHistory(streamSessionId, row.session_file, historyMode);
        if (diskBody.items.length > 0) {
          const body: StreamsHistoryResponse = {
            sessionId: streamSessionId,
            sessionFile: row.session_file,
            items: diskBody.items,
          };
          return sendJson(response, 200, body);
        }
        // DB row exists but file missing or empty — stale session from a previous runtime
        console.warn(
          "streams-history: session in DB but no history on disk (streamSessionId=%s, file=%s)",
          streamSessionId,
          row.session_file,
        );
      }
    }
    console.warn(
      "streams-history: session not found (streamSessionId=%s, mode=%s)",
      streamSessionId ?? "none",
      historyMode,
    );
    return sendJson(response, 404, { error: "Session not found" });
  }

  const items = await readSessionHistory(targetSession, historyMode);
  if (targetSession.streamName) {
    for (const item of items) {
      if (item.kind === "message") {
        item.streamName = targetSession.streamName;
      }
    }
  }
  const snapshot = targetSession.state.getSnapshot();
  const body: StreamsHistoryResponse = {
    sessionId: snapshot.sessionId ?? null,
    sessionFile: snapshot.sessionFile ?? null,
    items,
  };
  return sendJson(response, 200, body);
}
