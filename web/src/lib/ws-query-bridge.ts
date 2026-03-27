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
import { StreamChunker } from "~/lib/stream-chunker";
import { streamingStore } from "~/lib/streaming-store";
import type {
  ChatTimelineItem,
  ChatTimelineMessage,
  ChatTimelineTool,
  ConnectionState,
  DeliveryMode,
  ImageAttachment,
  JsonValue,
  WsMessage,
} from "~/lib/types";
import { createId, extractToolName } from "~/lib/utils";
import type { AutonomaWsClient } from "~/lib/ws";

/* ── Dev-only debug global ── */

declare global {
  interface Window {
    __streamChunker?: StreamChunker | null;
    __streamProfilingArmed?: boolean;
  }
}

function _devStreamChunker(): StreamChunker | null | undefined {
  return window.__streamChunker;
}

function _setDevStreamChunker(v: StreamChunker | null) {
  window.__streamChunker = v;
}

/* ── Send message factory (provided via router context) ── */

export type SendMessageFn = (
  text: string,
  deliveryMode: DeliveryMode,
  images?: ImageAttachment[],
  targetSessionId?: string,
) => Promise<void>;

export function createSendMessage(deps: {
  wsClient: AutonomaWsClient;
  apiClient: AutonomaApiClient;
  queryClient: QueryClient;
}): SendMessageFn {
  const { wsClient, apiClient, queryClient } = deps;
  return async (text, deliveryMode, images, targetSessionId) => {
    try {
      await wsClient.sendMessage(text, deliveryMode, images, targetSessionId);
    } catch (wsError) {
      console.error("WS send failed, trying HTTP fallback:", wsError);
      try {
        await apiClient.sendMessage({
          text,
          source: "web",
          deliveryMode,
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

/* ── Timeline append helper (deduplicates by ID) ── */

function appendTimelineItem(
  queryClient: QueryClient,
  sessionId: string,
  item: ChatTimelineItem,
  surface: "agent" | "input" = "agent",
) {
  if (surface === "input") {
    queryClient.setQueryData<ChatTimelineItem[]>(["pi-input-surface-timeline"], (old) => {
      const items = old ?? [];
      if (items.some((existing) => existing.id === item.id)) return items;
      return [...items, item];
    });
    return;
  }

  queryClient.setQueryData<ChatTimelineItem[]>(["pi-history", sessionId, "agent"], (old) => {
    const items = old ?? [];
    if (items.some((existing) => existing.id === item.id)) return items;
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

/* ── StreamChunker management ── */

const chunkers = new Map<string, { chunker: StreamChunker; flushedLength: number }>();

function destroyChunker(messageId: string) {
  const entry = chunkers.get(messageId);
  if (!entry) return;
  entry.chunker.destroy();
  chunkers.delete(messageId);
  if (import.meta.env.DEV && _devStreamChunker() === entry.chunker) {
    _setDevStreamChunker(null);
  }
}

function destroyAllChunkers() {
  for (const [, entry] of chunkers) {
    entry.chunker.destroy();
    if (import.meta.env.DEV && _devStreamChunker() === entry.chunker) {
      _setDevStreamChunker(null);
    }
  }
  chunkers.clear();
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

    // ── error ──
    if (message.type === "error") {
      const defaultSid = getDefaultSessionId();
      if (defaultSid) {
        addPill(queryClient, defaultSid, {
          id: createId("error"),
          label: message.message,
          variant: "error",
        });
      }
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

    // ── text_delta → StreamChunker → streaming store ──
    if (message.type === "text_delta") {
      const itemId = message.messageId;

      if (!chunkers.has(itemId)) {
        let flushedLength = 0;
        const chunker = new StreamChunker({
          onChunk: (fullText) => {
            const delta = fullText.slice(flushedLength);
            flushedLength = fullText.length;
            if (delta) {
              streamingStore.appendTextDelta(sessionId, itemId, delta);
            }
          },
        });
        chunkers.set(itemId, { chunker, flushedLength: 0 });

        if (import.meta.env.DEV) {
          _setDevStreamChunker(chunker);
          if (window.__streamProfilingArmed) {
            chunker.startProfiling();
            window.__streamProfilingArmed = false;
          }
        }
      }

      chunkers.get(itemId)!.chunker.push(message.delta);
      return;
    }

    // ── thinking_delta → streaming store ──
    if (message.type === "thinking_delta") {
      streamingStore.appendThinkingDelta(sessionId, message.messageId, message.delta);
      return;
    }

    // ── toolcall_start → streaming store ──
    if (message.type === "toolcall_start") {
      streamingStore.startToolCall(sessionId, message.contentIndex, message.toolName ?? "tool");
      return;
    }

    // ── toolcall_delta → streaming store ──
    if (message.type === "toolcall_delta") {
      streamingStore.appendToolCallDelta(sessionId, message.contentIndex, message.delta);
      return;
    }

    // ── message_end → Query cache ──
    if (message.type === "message_end") {
      const msg = message.message;
      const msgId = msg.id;

      // Destroy chunker for this message
      destroyChunker(msgId);

      // Add completed message to agent timeline
      if (msg.content.trim()) {
        appendTimelineItem(queryClient, sessionId, msg);
      }

      // Also add to input surface timeline (user messages from web/whatsapp, non-intermediate assistant messages)
      if (msg.role === "user") {
        const source = msg.source ?? "web";
        if (source === "web" || source === "whatsapp") {
          appendTimelineItem(queryClient, sessionId, msg, "input");
        }
      }
      // Don't add assistant message_end to input surface — only pi_surfaced events appear there

      // Clear streaming state AFTER appending the final message
      streamingStore.clearText(sessionId);
      streamingStore.clearThinking(sessionId);
      streamingStore.clearToolCalls(sessionId);
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

    // ── tool_execution_start / tool_execution_end ──
    if (message.type === "tool_execution_start" || message.type === "tool_execution_end") {
      const eventRecord =
        message.event && typeof message.event === "object"
          ? (message.event as Record<string, unknown>)
          : undefined;

      const toolEvent: ChatTimelineTool = {
        id: message.id ?? createId("tool"),
        kind: "tool",
        tool: message.tool || extractToolName(message.event),
        phase: message.type === "tool_execution_start" ? "start" : "end",
        toolUseId: message.toolUseId,
        args:
          message.type === "tool_execution_start"
            ? ((message.args ??
                eventRecord?.arguments ??
                eventRecord?.args ??
                eventRecord?.toolArguments) as JsonValue | undefined)
            : undefined,
        result:
          message.type === "tool_execution_end"
            ? ((message.result ??
                eventRecord?.result ??
                eventRecord?.output ??
                eventRecord?.toolResult) as JsonValue | undefined)
            : undefined,
        isError: message.type === "tool_execution_end" ? message.isError : undefined,
        createdAt: message.timestamp ?? new Date().toISOString(),
      };
      appendTimelineItem(queryClient, sessionId, toolEvent);
      return;
    }

    // ── turn_end ──
    if (message.type === "turn_end") {
      destroyAllChunkers();
      streamingStore.clearSession(sessionId);

      appendTimelineItem(queryClient, sessionId, {
        id: createId("divider-turn-end"),
        kind: "divider",
        createdAt: new Date().toISOString(),
      });
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
    destroyAllChunkers();
  };
}
