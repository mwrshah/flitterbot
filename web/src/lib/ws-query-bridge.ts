/**
 * WS → Query Cache bridge.
 *
 * Routes WebSocket events to TanStack Query cache via queryClient.setQueryData().
 * Replaces usePiWsHandler — this is a plain function, not a React hook.
 *
 * Lifecycle: call setupWsQueryBridge() once at app startup (in router.tsx or
 * root route). It returns a teardown function for cleanup.
 *
 * Streaming deltas (text_delta, thinking_delta, toolcall_*) go to the
 * streaming-store instead of Query cache (high-frequency, imperative updates).
 */

import type { QueryClient } from "@tanstack/react-query";
import type { AnyRouter } from "@tanstack/react-router";
import type { AutonomaApiClient } from "~/lib/api";
import type { StatusPill } from "~/lib/queries";
import { streamingStore } from "~/lib/streaming-store";
import type {
  ChatTimelineItem,
  ChatTimelineMessage,
  ChatTimelineTool,
  ConnectionState,

  ImageAttachment,
  JsonValue,
  WsMessage,
} from "~/lib/types";
import { createId, extractToolName } from "~/lib/utils";
import { toast } from "sonner";
import type { AutonomaWsClient } from "~/lib/ws";

/* ── Send message factory (provided via router context) ── */

export type SendMessageFn = (
  text: string,
  images?: ImageAttachment[],
  targetSessionId?: string,
) => Promise<void>;

export function createSendMessage(deps: {
  wsClient: AutonomaWsClient;
  apiClient: AutonomaApiClient;
  queryClient: QueryClient;
}): SendMessageFn {
  const { wsClient, apiClient, queryClient } = deps;
  return async (text, images, targetSessionId) => {
    try {
      await wsClient.sendMessage(text, "followUp", images, targetSessionId);
    } catch (wsError) {
      console.error("WS send failed, trying HTTP fallback:", wsError);
      try {
        await apiClient.sendMessage({
          text,
          source: "web",
          deliveryMode: "followUp",
          images,
          targetSessionId,
        });
      } catch (httpError) {
        console.error("HTTP fallback also failed:", httpError);
        const sid = targetSessionId ?? "default";
        addPill(queryClient, sid, {
          id: createId("send-error"),
          label: "Failed to send message",
          variant: "error",
        });
      }
    }
  };
}

/* ── Pill management helpers ── */

function addPill(queryClient: QueryClient, sessionId: string, pill: StatusPill) {
  queryClient.setQueryData<StatusPill[]>(["pi-status-pills", sessionId], (old) =>
    [...(old ?? []).filter((p) => p.id !== pill.id), pill].slice(-6),
  );
}

function removePill(queryClient: QueryClient, sessionId: string, pillId: string) {
  queryClient.setQueryData<StatusPill[]>(["pi-status-pills", sessionId], (old) =>
    (old ?? []).filter((p) => p.id !== pillId),
  );
}

/* ── Timeline append helper (no dedup — duplicates surface in UI to expose backend bugs) ── */

function appendTimelineItem(
  queryClient: QueryClient,
  sessionId: string,
  item: ChatTimelineItem,
  surface: "agent" | "input" = "agent",
) {
  if (surface === "input") {
    queryClient.setQueryData<ChatTimelineItem[]>(["pi-input-surface-timeline"], (old) =>
      [...(old ?? []), item],
    );
    return;
  }

  queryClient.setQueryData<ChatTimelineItem[]>(["pi-history", sessionId, "agent"], (old) => {
    const next = [...(old ?? []), item];
    console.log("[debug][ws-bridge] appendTimelineItem kind=%s → timeline.length=%d session=%s", item.kind, next.length, sessionId);
    return next;
  });
}

/* ── Timeline upsert helper (replace existing by ID, or append) ── */
/* Used for message_end: intermediate→final correction is the one expected replace. */

function upsertTimelineItem(
  queryClient: QueryClient,
  sessionId: string,
  item: ChatTimelineItem,
) {
  queryClient.setQueryData<ChatTimelineItem[]>(["pi-history", sessionId, "agent"], (old) => {
    const items = old ?? [];
    const idx = items.findIndex((existing) => existing.id === item.id);
    if (idx >= 0) {
      const prev = items[idx]!;
      // Expected path: intermediate assistant message replaced by final version on agent_end.
      // Anything else is a backend bug — log it so it's visible in devtools.
      const wasIntermediate = "intermediate" in prev && (prev as ChatTimelineMessage).intermediate;
      if (!wasIntermediate) {
        console.warn(
          "[ws-bridge] upsert replaced non-intermediate item id=%s — possible duplicate event",
          item.id,
        );
      }
      console.log("[debug][ws-bridge] upsertTimelineItem: replaced existing id=%s wasIntermediate=%s timeline.length=%d session=%s", item.id, wasIntermediate, items.length, sessionId);
      const updated = [...items];
      updated[idx] = item;
      return updated;
    }
    console.log("[debug][ws-bridge] upsertTimelineItem: appended (no existing id=%s) → timeline.length=%d session=%s", item.id, items.length + 1, sessionId);
    return [...items, item];
  });
}

/* ── Update timeline item in-place ── */

function updateTimelineItem(
  queryClient: QueryClient,
  sessionId: string,
  predicate: (item: ChatTimelineItem) => boolean,
  updater: (item: ChatTimelineItem) => ChatTimelineItem,
) {
  queryClient.setQueryData<ChatTimelineItem[]>(["pi-history", sessionId, "agent"], (old) => {
    if (!old) return old;
    const idx = old.findIndex(predicate);
    if (idx < 0) return old;
    const items = [...old];
    items[idx] = updater(items[idx]!);
    return items;
  });
}

/* ── Main setup ── */

export function setupWsQueryBridge(deps: {
  queryClient: QueryClient;
  wsClient: AutonomaWsClient;
  apiClient: AutonomaApiClient;
  router: AnyRouter;
  getDefaultSessionId: () => string | undefined;
}): () => void {
  const { queryClient, wsClient, apiClient, router, getDefaultSessionId } = deps;

  /* ── WS message handler ── */

  const unsubscribeMessages = wsClient.subscribe((message: WsMessage) => {
    const sessionId = "sessionId" in message && message.sessionId ? message.sessionId : undefined;

    // ── connected ──
    if (message.type === "connected") {
      const defaultSid = getDefaultSessionId();
      if (defaultSid) {
        addPill(queryClient, defaultSid, {
          id: "ws-connected",
          label: `WS ${message.clientId.slice(0, 8)}`,
        });
      }
      return;
    }

    // ── workstreams_changed / status_changed ──
    if (message.type === "workstreams_changed" || message.type === "status_changed") {
      queryClient.invalidateQueries({ queryKey: ["status"] });
      return;
    }

    // ── sessions_changed ──
    if (message.type === "sessions_changed") {
      queryClient.invalidateQueries({
        queryKey: ["pi-downstream-sessions", message.piSessionId],
      });
      return;
    }

    // ── worktree_changed ──
    if (message.type === "worktree_changed") {
      queryClient.invalidateQueries({ queryKey: ["pi-worktree", message.piSessionId] });
      return;
    }

    // ── error ──
    if (message.type === "error") {
      toast.error(message.message);
      return;
    }

    if (!sessionId) return;

    // ── queue_item_start ──
    if (message.type === "queue_item_start") {
      const sourceLabel =
        message.item.source === "whatsapp"
          ? "WhatsApp"
          : message.item.source === "hook"
            ? "Hook"
            : message.item.source === "cron"
              ? "Cron"
              : "Web";
      addPill(queryClient, sessionId, {
        id: `processing-${message.item.id}`,
        label: `Processing ${sourceLabel} message`,
        variant: message.item.source !== "web" ? "info" : undefined,
      });
      return;
    }

    // ── queue_item_end ──
    if (message.type === "queue_item_end") {
      removePill(queryClient, sessionId, `processing-${message.itemId}`);

      if (message.error) {
        addPill(queryClient, sessionId, {
          id: `error-${message.itemId}`,
          label: message.error,
          variant: "error",
        });
      }
      return;
    }

    // ── text_delta → streaming store ──
    if (message.type === "text_delta") {
      streamingStore.appendTextDelta(sessionId, message.messageId, message.delta);
      return;
    }

    // ── thinking lifecycle → streaming store ──
    if (message.type === "thinking_start") {
      streamingStore.setThinkingStreaming(sessionId, true, message.messageId);
      return;
    }

    if (message.type === "thinking_delta") {
      streamingStore.appendThinkingDelta(sessionId, message.messageId, message.delta);
      return;
    }

    if (message.type === "thinking_end") {
      streamingStore.setThinkingStreaming(sessionId, false);
      return;
    }

    // ── toolcall_start → buffer in streaming store ──
    // toolcall_start fires ~20ms before message_end. Committing to the Query cache
    // immediately puts the tool item before the assistant message in the array, which
    // breaks ordering. Buffer it here; message_end flushes it after the message.
    if (message.type === "toolcall_start") {
      if (message.toolUseId) {
        streamingStore.addPendingToolCall(sessionId, {
          toolUseId: message.toolUseId,
          toolName: message.toolName,
        });
      }
      return;
    }

    // ── message_end → agent timeline only (upsert) ──
    // Upsert so the agent_end correction (same id, no intermediate flag)
    // replaces the earlier intermediate version in-place.
    // Input surface is handled exclusively by pi_surfaced.
    if (message.type === "message_end") {
      const msg = message.message;
      const msgId = msg.id;

      if (msg.content.trim()) {
        // Include thinking blocks from the streaming store so the committed
        // message in the Query cache matches what history loading produces.
        // Without this, thinking disappears from the live session the moment
        // the message commits and only reappears after a page refresh.
        const thinkingText = streamingStore.getThinkingText(sessionId);
        const committed = thinkingText
          ? {
              ...msg,
              blocks: [
                { type: "thinking" as const, thinking: thinkingText },
                { type: "text" as const, text: msg.content },
              ],
            }
          : msg;
        upsertTimelineItem(queryClient, sessionId, committed);
      }

      // Flush tool calls buffered since toolcall_start. Appending them here (after the
      // assistant message) guarantees correct order: message first, tool items after.
      // tool_execution_start will then upgrade these "start" stubs with args in-place.
      const pendingTools = streamingStore.flushPendingToolCalls(sessionId);
      for (const tool of pendingTools) {
        appendTimelineItem(queryClient, sessionId, {
          id: createId("tool"),
          kind: "tool",
          tool: tool.toolName ?? "tool",
          phase: "start",
          toolUseId: tool.toolUseId,
          createdAt: new Date().toISOString(),
        });
      }

      // Clear all streaming state atomically. thinking is now in the cache so
      // nothing is lost — clearSession fires one callback with all-nulls which
      // triggers clearStreaming() on the Lit component.
      console.log("[debug][ws-bridge] message_end: calling clearSession for session=%s msgId=%s", sessionId, msg.id);
      streamingStore.clearSession(sessionId);
      return;
    }

    // ── pi_surfaced → input surface Query cache ──
    if (message.type === "pi_surfaced") {
      const surfacedMessage: ChatTimelineMessage = {
        ...message.message,
        workstreamId: message.message.workstreamId ?? message.workstreamId,
        workstreamName: message.message.workstreamName ?? message.workstreamName,
      };
      if (surfacedMessage.content.trim()) {
        appendTimelineItem(queryClient, sessionId, surfacedMessage, "input");
      }
      return;
    }

    // ── tool_execution_update ──
    if (message.type === "tool_execution_update") {
      updateTimelineItem(
        queryClient,
        sessionId,
        (item) =>
          item.kind === "tool" &&
          (item as ChatTimelineTool).toolUseId === message.toolUseId &&
          (item as ChatTimelineTool).phase === "start",
        (item) => ({
          ...(item as ChatTimelineTool),
          phase: "update" as const,
          result: message.partialResult as JsonValue | undefined,
        }),
      );
      return;
    }

    // ── tool_execution_start → upgrade pending tool card with args ──
    if (message.type === "tool_execution_start") {
      const eventRecord =
        message.event && typeof message.event === "object"
          ? (message.event as Record<string, unknown>)
          : undefined;
      const args = (message.args ??
        eventRecord?.arguments ??
        eventRecord?.args ??
        eventRecord?.toolArguments) as JsonValue | undefined;
      const tool = message.tool || extractToolName(message.event);
      const timestamp = message.timestamp ?? new Date().toISOString();

      // Try to upgrade the stub committed to cache by the message_end flush
      let upgraded = false;
      if (message.toolUseId) {
        queryClient.setQueryData<ChatTimelineItem[]>(
          ["pi-history", sessionId, "agent"],
          (old) => {
            if (!old) return old;
            const idx = old.findIndex(
              (item) =>
                item.kind === "tool" &&
                (item as ChatTimelineTool).toolUseId === message.toolUseId &&
                (item as ChatTimelineTool).phase === "start" &&
                (item as ChatTimelineTool).args == null,
            );
            if (idx < 0) return old;
            upgraded = true;
            const items = [...old];
            items[idx] = { ...(items[idx] as ChatTimelineTool), tool, args, createdAt: timestamp };
            return items;
          },
        );
      }

      // Fallback: no pending item (e.g. reconnect) — append fresh
      if (!upgraded) {
        appendTimelineItem(queryClient, sessionId, {
          id: message.id ?? createId("tool"),
          kind: "tool",
          tool,
          phase: "start",
          toolUseId: message.toolUseId,
          args,
          createdAt: timestamp,
        });
      }
      return;
    }

    // ── tool_execution_end ──
    if (message.type === "tool_execution_end") {
      const eventRecord =
        message.event && typeof message.event === "object"
          ? (message.event as Record<string, unknown>)
          : undefined;

      const toolEvent: ChatTimelineTool = {
        id: message.id ?? createId("tool"),
        kind: "tool",
        tool: message.tool || extractToolName(message.event),
        phase: "end",
        toolUseId: message.toolUseId,
        result: (message.result ??
          eventRecord?.result ??
          eventRecord?.output ??
          eventRecord?.toolResult) as JsonValue | undefined,
        isError: message.isError,
        createdAt: message.timestamp ?? new Date().toISOString(),
      };
      appendTimelineItem(queryClient, sessionId, toolEvent);
      return;
    }

    // ── turn_end ──
    if (message.type === "turn_end") {
      console.log("[debug][ws-bridge] turn_end: calling clearSession for session=%s", sessionId);
      streamingStore.clearSession(sessionId);
      return;
    }

    // ── agent_end ──
    // Always emitted by the Pi SDK, including when runAgentLoop throws (abort exception
    // path) which skips message_end and turn_end. If streaming text is still in the store
    // at this point, it was never committed — flush it as a partial assistant message.
    if (message.type === "agent_end") {
      const uncommitted = streamingStore.getUncommittedText(sessionId);
      if (uncommitted?.text.trim()) {
        console.log("[debug][ws-bridge] agent_end: flushing uncommitted text msgId=%s session=%s", uncommitted.messageId, sessionId);
        upsertTimelineItem(queryClient, sessionId, {
          id: uncommitted.messageId,
          kind: "message",
          role: "assistant",
          content: uncommitted.text,
          createdAt: new Date().toISOString(),
        });
      }
      console.log("[debug][ws-bridge] agent_end: calling clearSession hasUncommitted=%s session=%s", uncommitted?.text.trim() ? "yes" : "no", sessionId);
      streamingStore.clearSession(sessionId);
      return;
    }
  });

  /* ── Connection state handler — query cache + reconnect invalidation ── */

  // Seed initial connection state
  queryClient.setQueryData<ConnectionState>(["connection-state"], wsClient.connectionState);

  let prevConnectionState: ConnectionState = wsClient.connectionState;

  const unsubscribeConnection = wsClient.subscribeConnection((state: ConnectionState) => {
    const prev = prevConnectionState;
    prevConnectionState = state;

    // Write every transition to query cache
    queryClient.setQueryData<ConnectionState>(["connection-state"], state);

    if (state === "connected" && (prev === "disconnected" || prev === "reconnecting")) {
      // Re-fetch stale data after reconnect
      queryClient.invalidateQueries({ queryKey: ["status"] });
      queryClient.invalidateQueries({ queryKey: ["pi-history"] });
      queryClient.invalidateQueries({ queryKey: ["pi-input-surface-timeline"] });
      router.invalidate();
    }
  });

  /* ── Teardown ── */

  return () => {
    unsubscribeMessages();
    unsubscribeConnection();
  };
}
