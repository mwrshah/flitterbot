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
import { activeToolStore } from "~/lib/active-tool-store";
import { timelineItemsToAgentMessages } from "~/lib/pi-web-ui-bridge";
import { streamingStore } from "~/lib/streaming-store";
import type {
  ChatTimelineItem,
  ChatTimelineMessage,
  ChatTimelineTool,
  ImageAttachment,
  JsonValue,
  WsMessage,
} from "~/lib/types";
import { createId } from "~/lib/utils";
import type { FlitterbotWsClient } from "~/lib/ws";

/* ── Send message factory (provided via router context) ── */

type SendMessageOptions = {
  images?: ImageAttachment[];
  targetPiSessionId?: string;
  /** Client-generated UUID matching the optimistic user-message bubble in
   *  cache. The server echoes this on user-role `message_end` so the bridge
   *  can swap the optimistic entry for the canonical server-side one. */
  clientMessageId?: string;
};

export type SendMessageFn = (text: string, options?: SendMessageOptions) => Promise<void>;

export function createSendMessage(deps: { wsClient: FlitterbotWsClient }): SendMessageFn {
  const { wsClient } = deps;
  return async (text, options) => {
    try {
      await wsClient.sendMessage(text, "followUp", {
        images: options?.images,
        targetPiSessionId: options?.targetPiSessionId,
        clientMessageId: options?.clientMessageId,
      });
    } catch (error) {
      console.error("WS send failed (socket not open):", error);
      throw error;
    }
  };
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

/* ── Main setup ── */

export function setupWsQueryBridge(deps: {
  queryClient: QueryClient;
  wsClient: FlitterbotWsClient;
  router: AnyRouter;
}): () => void {
  const { queryClient, wsClient, router } = deps;

  /* ── WS message handler ── */

  const unsubscribeMessages = wsClient.subscribe((message: WsMessage) => {
    const piSessionId =
      "piSessionId" in message && message.piSessionId ? message.piSessionId : undefined;

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

    // ── history_rewritten ──
    if (message.type === "history_rewritten") {
      queryClient.invalidateQueries({
        queryKey: ["streams-history", message.piSessionId],
      });
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

    // ── resources_reloaded → refresh skills list + toast confirmation ──
    if (message.type === "resources_reloaded") {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      toast.success("Resources reloaded");
      return;
    }

    if (!piSessionId) return;

    // ── text_delta → streaming store ──
    if (message.type === "text_delta") {
      streamingStore.appendTextDelta(piSessionId, message.messageId, message.delta);
      return;
    }

    // ── thinking lifecycle → streaming store ──
    if (message.type === "thinking_start") {
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

      // Build all new timeline items from server-provided data, then commit
      // in a single setQueryData call to avoid intermediate renders.
      const blocks = (msg as ChatTimelineMessage).blocks;
      const hasContent = msg.content.trim() || (blocks && blocks.length > 0);
      const isUser = msg.role === "user";
      const clientMessageId = message.clientMessageId;

      if (hasContent || message.toolCalls?.length) {
        const now = new Date().toISOString();

        // Build the committed timeline items for both Query cache and imperative commit.
        const committedItems: ChatTimelineItem[] = [];
        if (hasContent) {
          // Stamp the echoed clientMessageId onto the canonical user message
          // so the structural-sharing comparator (mergeTimelineItems) can
          // recognise the optimistic bubble (id === clientMessageId) as
          // covered by the canonical (id === SDK entry.id). Without this,
          // structuralSharing re-appends the optimistic as an "extra" and
          // the user message renders twice.
          const stamped: ChatTimelineMessage =
            isUser && clientMessageId
              ? { ...msg, ...(blocks ? { blocks } : {}), clientMessageId }
              : blocks
                ? { ...msg, blocks }
                : msg;
          committedItems.push(stamped);
        }
        if (message.toolCalls?.length) {
          for (const tc of message.toolCalls) {
            committedItems.push({
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

        queryClient.setQueryData<ChatTimelineItem[]>(
          ["streams-history", piSessionId, "agent"],
          (old) => {
            const items = old ?? [];

            // Upsert the message. Try reconciling against existing entries in
            // this priority order:
            //   1. clientMessageId (web optimistic bubbles)
            //   2. serverMessageId (surface/input DB rows keyed by the
            //      runtime's pre-allocated DB row id)
            //   3. canonical id (entry.id) match for direct re-broadcasts
            // Falls through to append when nothing matches.
            let next = items;
            if (hasContent) {
              const committed = committedItems[0] as ChatTimelineMessage;
              const committedServerMessageId = committed.serverMessageId;
              let idx = -1;
              if (isUser && clientMessageId) {
                idx = items.findIndex(
                  (existing) => existing.kind === "message" && existing.id === clientMessageId,
                );
              }
              if (idx < 0 && committedServerMessageId) {
                idx = items.findIndex(
                  (existing) =>
                    existing.kind === "message" &&
                    (existing.id === committedServerMessageId ||
                      (existing as ChatTimelineMessage).serverMessageId ===
                        committedServerMessageId),
                );
              }
              if (idx < 0) {
                idx = items.findIndex((existing) => existing.id === committed.id);
              }
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
              const toolItems = hasContent ? committedItems.slice(1) : committedItems;
              for (const toolItem of toolItems) {
                const tc = toolItem as ChatTimelineTool;
                const alreadyExists = base.some(
                  (existing) =>
                    existing.kind === "tool" &&
                    (existing as ChatTimelineTool).toolUseId === tc.toolUseId &&
                    (existing as ChatTimelineTool).phase !== "end",
                );
                if (!alreadyExists) {
                  base.push(tc);
                }
              }
              next = base;
            }

            return next;
          },
        );

        // Imperative commit bypasses React for assistant messages (streaming
        // perf). User messages always render through the React path — the
        // optimistic entry is already in cache and on-screen by the time this
        // echo arrives, so a duplicate imperative append would double-render.
        if (!isUser) {
          const agentMessages = timelineItemsToAgentMessages(committedItems);
          if (agentMessages.length > 0) {
            console.log(
              "[debug][ws-bridge] message_end: imperative commit dispatched (%d agentMessages) for session=%s",
              agentMessages.length,
              piSessionId,
            );
            streamingStore.commitMessage(piSessionId, agentMessages);
          }
        }
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

    // ── tool_execution_update → imperative active-tool channel ──
    if (message.type === "tool_execution_update") {
      if (!message.toolUseId) return;
      activeToolStore.upsertTool(piSessionId, {
        toolUseId: message.toolUseId,
        pending: true,
        partialResult: message.partialResult,
      });
      return;
    }

    // ── tool_execution_start → imperative active-tool channel ──
    if (message.type === "tool_execution_start") {
      if (!message.toolUseId) return;
      activeToolStore.upsertTool(piSessionId, {
        toolUseId: message.toolUseId,
        pending: true,
      });
      return;
    }

    // ── tool_execution_end ──
    if (message.type === "tool_execution_end") {
      const eventRecord =
        message.event && typeof message.event === "object"
          ? (message.event as Record<string, unknown>)
          : undefined;
      if (!message.toolUseId) return;
      activeToolStore.upsertTool(piSessionId, {
        toolUseId: message.toolUseId,
        pending: false,
        partialResult:
          message.result ?? eventRecord?.result ?? eventRecord?.output ?? eventRecord?.toolResult,
        isError: message.isError,
      });
      return;
    }

    // ── tool_result → canonical durable tool flush ──
    if (message.type === "tool_result") {
      appendTimelineItem(queryClient, piSessionId, message.item);

      const [toolResultMessage] = timelineItemsToAgentMessages([message.item]);
      if (toolResultMessage) {
        streamingStore.commitToolResult(piSessionId, toolResultMessage);
      }
      if (message.item.toolUseId) {
        activeToolStore.dropTool(piSessionId, message.item.toolUseId);
      }
      return;
    }

    // ── turn_end ──
    if (message.type === "turn_end") {
      console.log("[debug][ws-bridge] turn_end: calling clearSession for session=%s", piSessionId);
      streamingStore.clearSession(piSessionId);
      activeToolStore.clearSession(piSessionId);
      return;
    }

    // ── agent_end ──
    if (message.type === "agent_end") {
      streamingStore.clearSession(piSessionId);
      activeToolStore.clearSession(piSessionId);
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
