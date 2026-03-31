/**
 * WS → Query Cache bridge.
 *
 * Routes WebSocket events to TanStack Query cache via queryClient.setQueryData().
 * Replaces useStreamWsHandler — this is a plain function, not a React hook.
 *
 * Lifecycle: call setupWsQueryBridge() once at app startup (in router.tsx or
 * root route). It returns a teardown function for cleanup.
 *
 * Streaming deltas (text_delta, thinking_delta, toolcall_*) go to the
 * streaming-store instead of Query cache (high-frequency, imperative updates).
 */

import type { QueryClient } from "@tanstack/react-query";
import type { AnyRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import type { AutonomaApiClient } from "~/lib/api";
import type { StatusPill } from "~/lib/queries";
import { streamingStore } from "~/lib/streaming-store";
import type {
  ChatTimelineItem,
  ChatTimelineMessage,
  ChatTimelineTool,
  ImageAttachment,
  JsonValue,
  WsMessage,
} from "~/lib/types";
import { createId, extractToolName } from "~/lib/utils";
import type { AutonomaWsClient } from "~/lib/ws";

/* ── Send message factory (provided via router context) ── */

export type SendMessageFn = (
  text: string,
  images?: ImageAttachment[],
  targetPiSessionId?: string,
) => Promise<void>;

export function createSendMessage(deps: {
  wsClient: AutonomaWsClient;
  apiClient: AutonomaApiClient;
  queryClient: QueryClient;
}): SendMessageFn {
  const { wsClient, apiClient, queryClient } = deps;
  return async (text, images, targetPiSessionId) => {
    try {
      await wsClient.sendMessage(text, "followUp", images, targetPiSessionId);
    } catch (wsError) {
      console.error("WS send failed, trying HTTP fallback:", wsError);
      try {
        await apiClient.sendMessage({
          text,
          source: "web",
          deliveryMode: "followUp",
          images,
          targetPiSessionId,
        });
      } catch (httpError) {
        console.error("HTTP fallback also failed:", httpError);
        const sid = targetPiSessionId ?? "default";
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
  queryClient.setQueryData<StatusPill[]>(["streams-status-pills", sessionId], (old) =>
    [...(old ?? []).filter((p) => p.id !== pill.id), pill].slice(-6),
  );
}

function removePill(queryClient: QueryClient, sessionId: string, pillId: string) {
  queryClient.setQueryData<StatusPill[]>(["streams-status-pills", sessionId], (old) =>
    (old ?? []).filter((p) => p.id !== pillId),
  );
}

/* ── Timeline append helper with dedup ── */

function appendTimelineItem(
  queryClient: QueryClient,
  sessionId: string,
  item: ChatTimelineItem,
  surface: "agent" | "input" = "agent",
) {
  if (surface === "input") {
    queryClient.setQueryData<ChatTimelineItem[]>(["surface-timeline"], (old) => {
      const items = old ?? [];

      // Dedup: check for an existing entry with same id, same serverMessageId,
      // or same content+role (catches optimistic entries from message_ack that
      // won't share an id with the surfaced message).
      if (item.kind === "message") {
        const msg = item as ChatTimelineMessage;
        const dupIdx = items.findIndex((existing) => {
          if (existing.kind !== "message") return false;
          const ex = existing as ChatTimelineMessage;
          if (ex.id === msg.id) return true;
          if (msg.serverMessageId && ex.serverMessageId === msg.serverMessageId) return true;
          if (ex.role === msg.role && ex.content === msg.content) return true;
          return false;
        });
        if (dupIdx >= 0) {
          console.log(
            "[debug][ws-bridge] appendTimelineItem DEDUP surface-timeline: replacing idx=%d with id=%s role=%s",
            dupIdx, msg.id, msg.role,
          );
          const updated = [...items];
          updated[dupIdx] = item;
          return updated;
        }
      }

      return [...items, item];
    });
    return;
  }

  queryClient.setQueryData<ChatTimelineItem[]>(["streams-history", sessionId, "agent"], (old) => {
    const items = old ?? [];

    // Dedup: skip if an item with the same identity already exists.
    // For tool items, match on toolUseId+phase; for messages, match on id.
    if (item.kind === "tool" && (item as ChatTimelineTool).toolUseId) {
      const tool = item as ChatTimelineTool;
      const dup = items.some(
        (existing) =>
          existing.kind === "tool" &&
          (existing as ChatTimelineTool).toolUseId === tool.toolUseId &&
          (existing as ChatTimelineTool).phase === tool.phase,
      );
      if (dup) {
        console.log(
          "[debug][ws-bridge] appendTimelineItem DEDUP skipped toolUseId=%s phase=%s session=%s",
          tool.toolUseId,
          tool.phase,
          sessionId,
        );
        return items;
      }
    } else if (item.kind === "message") {
      const dup = items.some((existing) => existing.id === item.id);
      if (dup) {
        console.log(
          "[debug][ws-bridge] appendTimelineItem DEDUP skipped id=%s session=%s",
          item.id,
          sessionId,
        );
        return items;
      }
    }

    const next = [...items, item];
    console.log(
      "[debug][ws-bridge] appendTimelineItem kind=%s → timeline.length=%d session=%s",
      item.kind,
      next.length,
      sessionId,
    );
    return next;
  });
}

/* ── Timeline upsert helper (replace existing by ID, or append) ── */
/* Used for message_end: intermediate→final correction is the one expected replace. */

function upsertTimelineItem(queryClient: QueryClient, sessionId: string, item: ChatTimelineItem) {
  queryClient.setQueryData<ChatTimelineItem[]>(["streams-history", sessionId, "agent"], (old) => {
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
      console.log(
        "[debug][ws-bridge] upsertTimelineItem: replaced existing id=%s wasIntermediate=%s timeline.length=%d session=%s",
        item.id,
        wasIntermediate,
        items.length,
        sessionId,
      );
      const updated = [...items];
      updated[idx] = item;
      return updated;
    }
    console.log(
      "[debug][ws-bridge] upsertTimelineItem: appended (no existing id=%s) → timeline.length=%d session=%s",
      item.id,
      items.length + 1,
      sessionId,
    );
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
  queryClient.setQueryData<ChatTimelineItem[]>(["streams-history", sessionId, "agent"], (old) => {
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
  router: AnyRouter;
  getDefaultPiSessionId: () => string | undefined;
}): () => void {
  const { queryClient, wsClient, router, getDefaultPiSessionId } = deps;

  /* ── WS message handler ── */

  const unsubscribeMessages = wsClient.subscribe((message: WsMessage) => {
    const piSessionId = "piSessionId" in message && message.piSessionId ? message.piSessionId : undefined;

    // ── connected ──
    if (message.type === "connected") {
      const defaultSid = getDefaultPiSessionId();
      if (defaultSid) {
        addPill(queryClient, defaultSid, {
          id: "ws-connected",
          label: `WS ${message.clientId.slice(0, 8)}`,
        });
      }
      return;
    }

    // ── streams_changed / status_changed ──
    if (message.type === "streams_changed" || message.type === "status_changed") {
      queryClient.invalidateQueries({ queryKey: ["status"] });
      return;
    }

    // ── sessions_changed ──
    if (message.type === "sessions_changed") {
      queryClient.invalidateQueries({
        queryKey: ["streams-downstream-sessions", message.piSessionId],
      });
      return;
    }

    // ── worktree_changed ──
    if (message.type === "worktree_changed") {
      queryClient.invalidateQueries({ queryKey: ["streams-worktree", message.piSessionId] });
      return;
    }

    // ── message_ack → optimistic user message on surface timeline ──
    if (message.type === "message_ack") {
      console.log(
        "[debug][ws-bridge] message_ack: adding optimistic entry smId=%s cacheSize=%d",
        message.serverMessageId,
        (queryClient.getQueryData<ChatTimelineItem[]>(["surface-timeline"]) ?? []).length,
      );
      queryClient.setQueryData<ChatTimelineItem[]>(["surface-timeline"], (old) => [
        ...(old ?? []),
        {
          id: message.serverMessageId,
          kind: "message" as const,
          role: "user" as const,
          content: message.text,
          source: message.source,
          serverMessageId: message.serverMessageId,
          createdAt: new Date().toISOString(),
        },
      ]);
      return;
    }

    // ── error ──
    if (message.type === "error") {
      toast.error(message.message);
      return;
    }

    // ── queue_item_start ──
    if (message.type === "queue_item_start") {
      const sid = piSessionId ?? getDefaultPiSessionId();
      if (!sid) return;
      const sourceLabel =
        message.item.source === "whatsapp"
          ? "WhatsApp"
          : message.item.source === "hook"
            ? "Hook"
            : message.item.source === "cron"
              ? "Cron"
              : message.item.source === "agent"
                ? "Agent"
                : message.item.source === "init"
                  ? "System"
                  : message.item.source === "stream_outbound"
                    ? "Streams"
                    : "Web";
      addPill(queryClient, sid, {
        id: `processing-${message.item.id}`,
        label: `Processing ${sourceLabel} message`,
        variant: message.item.source !== "web" ? "info" : undefined,
      });
      return;
    }

    // ── queue_item_end ──
    if (message.type === "queue_item_end") {
      const sid = piSessionId ?? getDefaultPiSessionId();
      if (!sid) return;
      removePill(queryClient, sid, `processing-${message.itemId}`);

      if (message.error) {
        addPill(queryClient, sid, {
          id: `error-${message.itemId}`,
          label: message.error,
          variant: "error",
        });
      }
      return;
    }

    if (!piSessionId) return;

    // ── message_start → typing indicator ──
    if (message.type === "message_start") {
      addPill(queryClient, piSessionId, {
        id: "assistant-typing",
        label: "Thinking…",
      });
      return;
    }

    // ── text_delta → streaming store ──
    if (message.type === "text_delta") {
      // Remove typing indicator once real content starts flowing
      removePill(queryClient, piSessionId, "assistant-typing");
      streamingStore.appendTextDelta(piSessionId, message.messageId, message.delta);
      return;
    }

    // ── thinking lifecycle → streaming store ──
    if (message.type === "thinking_start") {
      // Remove typing indicator once thinking starts
      removePill(queryClient, piSessionId, "assistant-typing");
      streamingStore.setThinkingStreaming(piSessionId, true, message.messageId);
      return;
    }

    if (message.type === "thinking_delta") {
      streamingStore.appendThinkingDelta(piSessionId, message.messageId, message.delta);
      return;
    }

    if (message.type === "thinking_end") {
      streamingStore.setThinkingStreaming(piSessionId, false);
      return;
    }

    // ── toolcall_start → buffer in streaming store ──
    if (message.type === "toolcall_start") {
      if (message.toolUseId) {
        streamingStore.addPendingToolCall(piSessionId, {
          toolUseId: message.toolUseId,
          toolName: message.toolName,
        });
      }
      return;
    }

    // ── message_end → agent timeline only (upsert) ──
    if (message.type === "message_end") {
      const msg = message.message;

      // Remove typing indicator on message commit
      removePill(queryClient, piSessionId, "assistant-typing");

      // Always capture thinking from the streaming store — it must be committed
      // to the Query cache regardless of whether there's text content.
      const thinkingText = streamingStore.getThinkingText(piSessionId);

      if (msg.content.trim() || thinkingText) {
        // Build the committed message with both thinking and text blocks.
        // Even if content is empty, thinking-only messages are preserved.
        const blocks: Array<
          { type: "text"; text: string } | { type: "thinking"; thinking: string }
        > = [];
        if (thinkingText) {
          blocks.push({ type: "thinking" as const, thinking: thinkingText });
        }
        if (msg.content.trim()) {
          blocks.push({ type: "text" as const, text: msg.content });
        }

        const committed = { ...msg, blocks };
        upsertTimelineItem(queryClient, piSessionId, committed);
      }

      // Flush tool calls buffered since toolcall_start.
      const pendingTools = streamingStore.flushPendingToolCalls(piSessionId);
      for (const tool of pendingTools) {
        appendTimelineItem(queryClient, piSessionId, {
          id: createId("tool"),
          kind: "tool",
          tool: tool.toolName ?? "tool",
          phase: "start",
          toolUseId: tool.toolUseId,
          createdAt: new Date().toISOString(),
        });
      }

      // Clear all streaming state atomically.
      console.log(
        "[debug][ws-bridge] message_end: calling clearSession for session=%s msgId=%s",
        piSessionId,
        msg.id,
      );
      streamingStore.clearSession(piSessionId);
      return;
    }

    // ── stream_surfaced → input surface Query cache ──
    if (message.type === "stream_surfaced") {
      const surfacedMessage: ChatTimelineMessage = {
        ...message.message,
        streamId: message.message.streamId ?? message.streamId,
        streamName: message.message.streamName ?? message.streamName,
      };
      if (!surfacedMessage.content.trim()) return;

      // Reconcile: if this message has a serverMessageId, replace the optimistic entry
      const smId = surfacedMessage.serverMessageId;
      if (smId) {
        queryClient.setQueryData<ChatTimelineItem[]>(["surface-timeline"], (old) => {
          if (!old) {
            console.log("[debug][ws-bridge] stream_surfaced: no cache, creating fresh smId=%s", smId);
            return [surfacedMessage];
          }
          const idx = old.findIndex(
            (item) =>
              item.kind === "message" &&
              (item as ChatTimelineMessage).serverMessageId === smId,
          );
          if (idx >= 0) {
            console.log(
              "[debug][ws-bridge] stream_surfaced: DEDUP SUCCESS smId=%s matched at idx=%d cacheSize=%d existingId=%s",
              smId, idx, old.length, old[idx]!.id,
            );
            const updated = [...old];
            updated[idx] = surfacedMessage;
            return updated;
          }
          console.log(
            "[debug][ws-bridge] stream_surfaced: DEDUP FAILED smId=%s not found in cache, appending. cacheSize=%d items=%s",
            smId, old.length,
            JSON.stringify(old.map((item) => ({ id: item.id, kind: item.kind, smId: (item as ChatTimelineMessage).serverMessageId }))),
          );
          return [...old, surfacedMessage];
        });
      } else {
console.log(
          "[debug][ws-bridge] stream_surfaced: no serverMessageId, appending via appendTimelineItem. surfacedId=%s role=%s",
          surfacedMessage.id, surfacedMessage.role,
        );
        appendTimelineItem(queryClient, piSessionId, surfacedMessage, "input");
      }
      return;
    }

    // ── tool_execution_update ──
    if (message.type === "tool_execution_update") {
      updateTimelineItem(
        queryClient,
        piSessionId,
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
          ["streams-history", piSessionId, "agent"],
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
        appendTimelineItem(queryClient, piSessionId, {
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
      appendTimelineItem(queryClient, piSessionId, toolEvent);
      return;
    }

    // ── turn_end ──
    if (message.type === "turn_end") {
      console.log("[debug][ws-bridge] turn_end: calling clearSession for session=%s", piSessionId);
      streamingStore.clearSession(piSessionId);
      return;
    }

    // ── agent_end ──
    if (message.type === "agent_end") {
      // Remove typing indicator if still present
      removePill(queryClient, piSessionId, "assistant-typing");

      const uncommitted = streamingStore.getUncommittedText(piSessionId);
      if (uncommitted?.text.trim()) {
        console.log(
          "[debug][ws-bridge] agent_end: flushing uncommitted text msgId=%s session=%s",
          uncommitted.messageId,
          piSessionId,
        );
        upsertTimelineItem(queryClient, piSessionId, {
          id: uncommitted.messageId,
          kind: "message",
          role: "assistant",
          content: uncommitted.text,
          createdAt: new Date().toISOString(),
        });
      }
      console.log(
        "[debug][ws-bridge] agent_end: calling clearSession hasUncommitted=%s session=%s",
        uncommitted?.text.trim() ? "yes" : "no",
        piSessionId,
      );
      streamingStore.clearSession(piSessionId);
      return;
    }
  });

  /* ── Connection state handler — query cache + reconnect invalidation ── */

  let prevConnectionState = wsClient.connectionState;

  const unsubscribeConnection = wsClient.subscribeConnection((state) => {
    const prev = prevConnectionState;
    prevConnectionState = state;

    if (state === "connected" && (prev === "disconnected" || prev === "reconnecting")) {
      // Re-fetch stale data after reconnect
      queryClient.invalidateQueries({ queryKey: ["status"] });
      queryClient.invalidateQueries({ queryKey: ["streams-history"] });
      queryClient.invalidateQueries({ queryKey: ["surface-timeline"] });
      router.invalidate();
    }
  });

  /* ── Teardown ── */

  return () => {
    unsubscribeMessages();
    unsubscribeConnection();
  };
}
