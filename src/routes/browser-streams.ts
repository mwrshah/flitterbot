import type http from "node:http";
import { getInputSurfaceHistory } from "../blackboard/query-messages.ts";
import { getLatestPiSessionId, listRecentlyClosedStreams } from "../blackboard/query-streams.ts";
import type {
  ChatTimelineItem,
  ChatTimelineMessage,
  StreamsHistoryResponse,
} from "../contracts/index.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { readStreamsHistory, readStreamsHistoryFromSession } from "../streams/history.ts";
import type { ManagedPiSession } from "../streams/pi-session-manager.ts";
import type { QueueItem } from "../streams/turn-queue.ts";
import { sendJson } from "./_shared.ts";

/**
 * Build placeholder ChatTimelineMessages for user-originated turn-queue
 * items that haven't yet been appended to the SDK SessionManager. Lets the
 * agent timeline survive a full page reload between submit and `message_end`
 * — without these, a fresh fetch would return the SDK's branch (which
 * doesn't know about in-flight messages yet) and the user's just-submitted
 * bubble would vanish until the WS echo arrives.
 *
 * Id strategy: prefer `clientMessageId` so an existing optimistic bubble
 * in the React-Query cache (id === clientMessageId) is recognised as the
 * same item by the structural-sharing comparator. Fall back to
 * `serverMessageId` for non-web sources (whatsapp/cron) that never had an
 * optimistic but should still appear as pending. The eventual user-role
 * `message_end` carries both, and the WS bridge swap matches whichever
 * key the placeholder used.
 */
function pendingItemsToPlaceholders(items: QueueItem[]): ChatTimelineMessage[] {
  const placeholders: ChatTimelineMessage[] = [];
  for (const item of items) {
    if (item.sender !== "user") continue;
    const id = item.clientMessageId ?? item.serverMessageId;
    if (!id) continue;
    const placeholder: ChatTimelineMessage = {
      id,
      kind: "message",
      role: "user",
      content: item.text,
      source: item.source,
      streamId: item.streamId,
      streamName: item.streamName,
      streaming: true,
      createdAt: item.receivedAt,
    };
    if (item.clientMessageId) placeholder.clientMessageId = item.clientMessageId;
    if (item.serverMessageId) placeholder.serverMessageId = item.serverMessageId;
    placeholders.push(placeholder);
  }
  return placeholders;
}

async function readSessionHistory(
  managed: ManagedPiSession,
  historyMode: "input" | "agent",
): Promise<ChatTimelineItem[]> {
  const snapshot = managed.state.getSnapshot();
  if (!snapshot.piSessionId) return [];

  let items: ChatTimelineItem[];

  // Prefer the live SessionManager when the session is active — getBranch()
  // returns entries on the current leaf's path, so pruned branches are
  // correctly excluded.
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

  // When a turn is in progress, suppress the trailing assistant message —
  // it's an intermediate response that will change once tool calls finish.
  if (historyMode === "input" && snapshot.busy && items.length > 0) {
    const last = items[items.length - 1]!;
    if (last.kind === "message" && last.role === "assistant") {
      items = items.slice(0, -1);
    }
  }

  // Append pending user-input placeholders so a full page reload between
  // submit and SDK appendMessage doesn't drop the user's message from the
  // agent timeline. Skipped for `input` mode — the input surface reads
  // from the messages table (which already records inbound rows at
  // runtime.enqueueMessage time), so it has its own durability path.
  if (historyMode === "agent") {
    const placeholders = pendingItemsToPlaceholders(managed.queue.getPendingItems());
    if (placeholders.length > 0) {
      items = [...items, ...placeholders];
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
  // Surface with no specific session — read from the messages table
  if (historyMode === "input" && !piSessionId) {
    // Collect all relevant pi_session_ids: default + active orchestrators + recently-closed streams
    const piSessionIds: string[] = [];
    const defaultPiSessionId = runtime.sessionManager.getDefault()?.piSessionId;
    if (defaultPiSessionId) piSessionIds.push(defaultPiSessionId);
    for (const orch of runtime.sessionManager.listOrchestrators()) {
      if (orch.piSessionId) piSessionIds.push(orch.piSessionId);
    }
    // Include closed streams (24h) — look up their pi_session_ids
    const closedStreams = listRecentlyClosedStreams(runtime.blackboard, 24);
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

  // Specific session or agent mode — existing single-session path
  const targetSession = piSessionId
    ? runtime.sessionManager.getByPiSessionId(piSessionId)
    : runtime.sessionManager.getDefault();

  if (!targetSession) {
    // Session not in memory — fall back to reading history from disk (e.g. closed streams)
    if (piSessionId) {
      const row = runtime.blackboard
        .prepare("SELECT session_file FROM pi_sessions WHERE pi_session_id = ?")
        .get(piSessionId) as { session_file: string | null } | undefined;
      if (row?.session_file) {
        const diskBody = readStreamsHistory(piSessionId, row.session_file, historyMode);
        if (diskBody.items.length > 0) {
          const body: StreamsHistoryResponse = {
            piSessionId: piSessionId,
            sessionFile: row.session_file,
            items: diskBody.items,
          };
          return sendJson(response, 200, body);
        }
        // DB row exists but file missing or empty — stale session from a previous runtime
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
    piSessionId: snapshot.piSessionId ?? null,
    sessionFile: snapshot.sessionFile ?? null,
    items,
  };
  return sendJson(response, 200, body);
}
