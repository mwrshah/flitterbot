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
}): SendMessageFn {
  const { wsClient } = deps;
  return async (text, images, targetPiSessionId) => {
    try {
      await wsClient.sendMessage(text, "followUp", images, targetPiSessionId);
    } catch (error) {
      console.error("WS send failed (socket not open):", error);
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
            dupIdx,
            msg.id,
            msg.role,
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
    // For tool end items, match on toolUseId+phase; for messages, match on id.
    if (item.kind === "tool" && (item as ChatTimelineTool).toolUseId) {
      const tool = item as ChatTimelineTool;
      if (tool.phase !== "end") {
        const dup = items.some(
          (existing) =>
            existing.kind === "tool" &&
            (existing as ChatTimelineTool).toolUseId === tool.toolUseId &&
            (existing as ChatTimelineTool).phase !== "end",
        );
        if (dup) {
          console.log(
            "[debug][ws-bridge] appendTimelineItem DEDUP skipped active toolUseId=%s phase=%s session=%s",
            tool.toolUseId,
            tool.phase,
            sessionId,
          );
          return items;
        }
      }
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

function mergeToolItem(prev: ChatTimelineTool, next: ChatTimelineTool): ChatTimelineTool {
  return {
    ...prev,
    ...next,
    id: prev.id,
    tool: next.tool === "tool" && prev.tool !== "tool" ? prev.tool : next.tool,
    toolUseId: next.toolUseId ?? prev.toolUseId,
    args: next.args ?? prev.args,
    result: next.result ?? prev.result,
    isError: next.isError ?? prev.isError,
    createdAt: next.createdAt ?? prev.createdAt,
  };
}

function upsertActiveToolItem(queryClient: QueryClient, sessionId: string, item: ChatTimelineTool) {
  queryClient.setQueryData<ChatTimelineItem[]>(["streams-history", sessionId, "agent"], (old) => {
    const items = old ?? [];
    if (!item.toolUseId || item.phase === "end") {
      return [...items, item];
    }

    const idx = items.findIndex(
      (existing) =>
        existing.kind === "tool" &&
        (existing as ChatTimelineTool).toolUseId === item.toolUseId &&
        (existing as ChatTimelineTool).phase !== "end",
    );

    if (idx < 0) {
      console.log(
        "[debug][ws-bridge] upsertActiveToolItem: appended toolUseId=%s phase=%s timeline.length=%d session=%s",
        item.toolUseId,
        item.phase,
        items.length + 1,
        sessionId,
      );
      return [...items, item];
    }

    const prev = items[idx] as ChatTimelineTool;
    const updated = [...items];
    updated[idx] = mergeToolItem(prev, item);
    console.log(
      "[debug][ws-bridge] upsertActiveToolItem: replaced toolUseId=%s prevPhase=%s nextPhase=%s timeline.length=%d session=%s",
      item.toolUseId,
      prev.phase,
      item.phase,
      items.length,
      sessionId,
    );
    return updated;
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
    const piSessionId =
      "piSessionId" in message && message.piSessionId ? message.piSessionId : undefined;

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

    // ── toolcall_start (no-op — tool calls are committed via message_end) ──
    if (message.type === "toolcall_start") {
      return;
    }

    // ── message_end → commit message + tool calls atomically ──
    if (message.type === "message_end") {
      const msg = message.message;

      removePill(queryClient, piSessionId, "assistant-typing");

      // Build all new timeline items from server-provided data, then commit
      // in a single setQueryData call to avoid intermediate renders.
      const blocks = (msg as ChatTimelineMessage).blocks;
      const hasContent = msg.content.trim() || (blocks && blocks.length > 0);

      if (hasContent || message.toolCalls?.length) {
        const now = new Date().toISOString();
        queryClient.setQueryData<ChatTimelineItem[]>(
          ["streams-history", piSessionId, "agent"],
          (old) => {
            const items = old ?? [];

            // Upsert the message (replace existing by ID, or append).
            let next = items;
            if (hasContent) {
              const committed = blocks ? { ...msg, blocks } : msg;
              const idx = items.findIndex((existing) => existing.id === committed.id);
              if (idx >= 0) {
                next = [...items];
                next[idx] = committed;
              } else {
                next = [...items, committed];
              }
            }

            // Append tool call start items from the server (dedup by toolUseId).
            if (message.toolCalls?.length) {
              const base = next === items ? [...items] : next;
              for (const tc of message.toolCalls) {
                const alreadyExists = base.some(
                  (existing) =>
                    existing.kind === "tool" &&
                    (existing as ChatTimelineTool).toolUseId === tc.toolUseId &&
                    (existing as ChatTimelineTool).phase !== "end",
                );
                if (!alreadyExists) {
                  base.push({
                    id: createId("tool"),
                    kind: "tool",
                    tool: tc.toolName ?? "tool",
                    phase: "start",
                    toolUseId: tc.toolUseId,
                    args: tc.args as JsonValue | undefined,
                    createdAt: now,
                  });
                }
              }
              next = base;
            }

            return next;
          },
        );
      }

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
            console.log(
              "[debug][ws-bridge] stream_surfaced: no cache, creating fresh smId=%s",
              smId,
            );
            return [surfacedMessage];
          }
          const idx = old.findIndex(
            (item) =>
              item.kind === "message" && (item as ChatTimelineMessage).serverMessageId === smId,
          );
          if (idx >= 0) {
            const updated = [...old];
            updated[idx] = surfacedMessage;
            return updated;
          }
          return [...old, surfacedMessage];
        });
      } else {
        console.log(
          "[debug][ws-bridge] stream_surfaced: no serverMessageId, appending via appendTimelineItem. surfacedId=%s role=%s",
          surfacedMessage.id,
          surfacedMessage.role,
        );
        appendTimelineItem(queryClient, piSessionId, surfacedMessage, "input");
      }
      return;
    }

    // ── tool_execution_update ──
    if (message.type === "tool_execution_update") {
      upsertActiveToolItem(queryClient, piSessionId, {
        id: createId("tool"),
        kind: "tool",
        tool: "tool",
        phase: "update",
        toolUseId: message.toolUseId,
        result: message.partialResult as JsonValue | undefined,
        createdAt: new Date().toISOString(),
      });
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

      upsertActiveToolItem(queryClient, piSessionId, {
        id: message.id ?? createId("tool"),
        kind: "tool",
        tool,
        phase: "start",
        toolUseId: message.toolUseId,
        args,
        createdAt: timestamp,
      });
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
      removePill(queryClient, piSessionId, "assistant-typing");
      streamingStore.clearSession(piSessionId);
      if (message.aborted) {
        // message_end was skipped (abort) — revalidate from the server session file.
        queryClient.invalidateQueries({ queryKey: ["streams-history", piSessionId, "agent"] });
      }
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
