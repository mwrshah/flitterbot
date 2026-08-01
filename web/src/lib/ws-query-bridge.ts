import type { QueryClient } from "@tanstack/react-query";
import type { AnyRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { activeToolStore } from "~/lib/active-tool-store";
import { streamingUiDebug } from "~/lib/debug-log";
import {
  appendItemToPage,
  commitMessageEndToPage,
  updateNewestHistoryPage,
} from "~/lib/history-cache";
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

type SendMessageOptions = {
  images?: ImageAttachment[];
  targetPiSessionId?: string;
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

function appendTimelineItem(
  queryClient: QueryClient,
  sessionId: string,
  item: ChatTimelineItem,
  surface: "agent" | "input" = "agent",
) {
  if (surface === "input") {
    queryClient.setQueryData<ChatTimelineItem[]>(["surface-timeline"], (old) => {
      const items = old ?? [];

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
          streamingUiDebug(
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

  updateNewestHistoryPage(queryClient, sessionId, (items) => {
    const next = appendItemToPage(items, item);
    if (next === items) {
      streamingUiDebug(
        "[debug][ws-bridge] appendTimelineItem DEDUP skipped kind=%s id=%s session=%s",
        item.kind,
        item.id,
        sessionId,
      );
      return items;
    }
    streamingUiDebug(
      "[debug][ws-bridge] appendTimelineItem kind=%s → newest page length=%d session=%s",
      item.kind,
      next.length,
      sessionId,
    );
    return next;
  });
}

export function setupWsQueryBridge(deps: {
  queryClient: QueryClient;
  wsClient: FlitterbotWsClient;
  router: AnyRouter;
}): () => void {
  const { queryClient, wsClient, router } = deps;

  const unsubscribeMessages = wsClient.subscribe((message: WsMessage) => {
    const piSessionId =
      "piSessionId" in message && message.piSessionId ? message.piSessionId : undefined;

    if (message.type === "streams_changed" || message.type === "status_changed") {
      queryClient.invalidateQueries({ queryKey: ["status"] });
      return;
    }

    if (message.type === "sessions_changed") {
      queryClient.invalidateQueries({
        queryKey: ["streams-downstream-sessions", message.piSessionId],
      });
      return;
    }

    if (message.type === "worktree_changed") {
      queryClient.invalidateQueries({ queryKey: ["streams-worktree", message.piSessionId] });
      return;
    }

    if (message.type === "history_rewritten") {
      queryClient.invalidateQueries({
        queryKey: ["streams-history", message.piSessionId],
      });
      return;
    }

    if (message.type === "message_ack") {
      streamingUiDebug(
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

    if (message.type === "error") {
      toast.error(message.message);
      return;
    }

    if (message.type === "resources_reloaded") {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      toast.success("Resources reloaded");
      return;
    }

    if (!piSessionId) return;

    if (message.type === "text_delta") {
      streamingStore.appendTextDelta(piSessionId, message.messageId, message.delta);
      return;
    }

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

    if (message.type === "toolcall_start") {
      return;
    }

    if (message.type === "message_end") {
      const msg = message.message;

      const blocks = (msg as ChatTimelineMessage).blocks;
      const hasContent = msg.content.trim() || (blocks && blocks.length > 0);
      const isUser = msg.role === "user";
      const clientMessageId = message.clientMessageId;

      if (hasContent || message.toolCalls?.length) {
        const now = new Date().toISOString();

        const committed: ChatTimelineMessage | undefined = hasContent
          ? isUser && clientMessageId
            ? { ...msg, ...(blocks ? { blocks } : {}), clientMessageId }
            : blocks
              ? { ...msg, blocks }
              : msg
          : undefined;

        const toolItems: ChatTimelineTool[] = (message.toolCalls ?? []).map((tc) => ({
          id: createId("tool"),
          kind: "tool",
          tool: tc.toolName ?? "tool",
          phase: "start",
          toolUseId: tc.toolUseId,
          args: tc.args as JsonValue | undefined,
          displayArgs: tc.displayArgs as JsonValue | undefined,
          createdAt: now,
        }));

        updateNewestHistoryPage(queryClient, piSessionId, (items) =>
          commitMessageEndToPage(items, {
            ...(committed ? { committed } : {}),
            ...(clientMessageId ? { clientMessageId } : {}),
            isUser,
            toolItems,
          }),
        );
      }

      streamingStore.clearSession(piSessionId);
      return;
    }

    if (message.type === "stream_surfaced") {
      const surfacedMessage: ChatTimelineMessage = {
        ...message.message,
        streamId: message.message.streamId ?? message.streamId,
        streamName: message.message.streamName ?? message.streamName,
      };
      if (!surfacedMessage.content.trim()) return;

      const smId = surfacedMessage.serverMessageId;
      if (smId) {
        queryClient.setQueryData<ChatTimelineItem[]>(["surface-timeline"], (old) => {
          if (!old) {
            streamingUiDebug(
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
        streamingUiDebug(
          "[debug][ws-bridge] stream_surfaced: no serverMessageId, appending via appendTimelineItem. surfacedId=%s role=%s",
          surfacedMessage.id,
          surfacedMessage.role,
        );
        appendTimelineItem(queryClient, piSessionId, surfacedMessage, "input");
      }
      return;
    }

    if (message.type === "tool_execution_update") {
      if (!message.toolUseId) return;
      activeToolStore.upsertTool(piSessionId, {
        toolUseId: message.toolUseId,
        pending: true,
        partialResult: message.partialResult,
      });
      return;
    }

    if (message.type === "tool_execution_start") {
      if (!message.toolUseId) return;
      activeToolStore.upsertTool(piSessionId, {
        toolUseId: message.toolUseId,
        pending: true,
      });
      return;
    }

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

    if (message.type === "tool_result") {
      appendTimelineItem(queryClient, piSessionId, message.item);

      if (message.item.toolUseId) {
        activeToolStore.dropTool(piSessionId, message.item.toolUseId);
      }
      return;
    }

    if (message.type === "turn_end") {
      streamingUiDebug(
        "[debug][ws-bridge] turn_end: calling clearSession for session=%s",
        piSessionId,
      );
      streamingStore.clearSession(piSessionId);
      activeToolStore.clearSession(piSessionId);
      return;
    }

    if (message.type === "agent_end") {
      streamingStore.clearSession(piSessionId);
      activeToolStore.clearSession(piSessionId);
      if (message.aborted) {
        queryClient.invalidateQueries({ queryKey: ["streams-history", piSessionId, "agent"] });
      }
      return;
    }
  });

  let prevConnectionState = wsClient.connectionState;

  const unsubscribeConnection = wsClient.subscribeConnection((state) => {
    const prev = prevConnectionState;
    prevConnectionState = state;

    if (state === "connected" && (prev === "disconnected" || prev === "reconnecting")) {
      queryClient.invalidateQueries({ queryKey: ["status"] });
      queryClient.invalidateQueries({ queryKey: ["streams-history"] });
      queryClient.invalidateQueries({ queryKey: ["surface-timeline"] });
      router.invalidate();
    }
  });

  return () => {
    unsubscribeMessages();
    unsubscribeConnection();
  };
}
