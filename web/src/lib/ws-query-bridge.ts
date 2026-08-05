import type { QueryClient } from "@tanstack/react-query";
import type { AnyRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  historyQueryKey,
  latestHistoryPosition,
  surfaceQueryKey,
  upsertNewestHistoryItems,
} from "~/lib/conversation-history";
import { conversationState } from "~/lib/conversation-state";
import { streamingUiDebug } from "~/lib/debug-log";
import type { ChatTimelineMessage, ChatTimelineTool, JsonValue } from "~/lib/types";
import type { FlitterbotWsClient } from "~/lib/ws";

export function setupWsQueryBridge(deps: {
  queryClient: QueryClient;
  wsClient: FlitterbotWsClient;
  router: AnyRouter;
}): () => void {
  const { queryClient, wsClient, router } = deps;
  const recovering = new Set<string>();

  const reloadHistory = async (piSessionId: string) => {
    if (recovering.has(piSessionId)) return;
    recovering.add(piSessionId);
    wsClient.pauseSessionSubscription(piSessionId);
    conversationState.clear(piSessionId);
    queryClient.removeQueries({ queryKey: historyQueryKey(piSessionId), exact: true });

    try {
      await router.invalidate();
      if (wsClient.activeSubscriptionPiSessionId() !== piSessionId) return;
      const data = queryClient.getQueryData<{
        pages: Array<{ live?: Parameters<typeof conversationState.installSnapshot>[1] }>;
      }>(historyQueryKey(piSessionId));
      conversationState.installSnapshot(piSessionId, data?.pages.at(-1)?.live);
      wsClient.setResumePosition(piSessionId, latestHistoryPosition(queryClient, piSessionId));
      wsClient.resumeSessionSubscription();
    } catch (error) {
      toast.error(`Failed to reload session history: ${String(error)}`);
    } finally {
      recovering.delete(piSessionId);
    }
  };

  const unsubscribeMessages = wsClient.subscribe((message) => {
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

    if (message.type === "error") {
      if (message.piSessionId) void reloadHistory(message.piSessionId);
      toast.error(message.message);
      return;
    }

    if (message.type === "resources_reloaded") {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      toast.success("Resources reloaded");
      return;
    }

    if (!piSessionId || recovering.has(piSessionId)) return;

    if (message.type === "conversation_reset" || message.type === "history_rewritten") {
      void reloadHistory(piSessionId);
      return;
    }

    if (message.type === "text_delta") {
      conversationState.textDelta(piSessionId, message.messageId, message.delta);
      return;
    }

    if (message.type === "thinking_start") {
      conversationState.thinkingStart(piSessionId, message.messageId);
      return;
    }

    if (message.type === "thinking_delta") {
      conversationState.thinkingDelta(piSessionId, message.messageId, message.delta);
      return;
    }

    if (message.type === "thinking_end") {
      conversationState.thinkingEnd(piSessionId, message.messageId);
      return;
    }

    if (message.type === "message_end") {
      const msg = message.message;
      const blocks = (msg as ChatTimelineMessage).blocks;
      const hasContent = Boolean(msg.content.trim() || blocks?.length || msg.images?.length);
      const items: Array<ChatTimelineMessage | ChatTimelineTool> = [];
      if (hasContent) items.push(blocks ? { ...msg, blocks } : msg);

      const now = new Date().toISOString();
      for (const toolCall of message.toolCalls ?? []) {
        items.push({
          id: `tool-${toolCall.toolUseId}-start`,
          kind: "tool",
          tool: toolCall.toolName,
          phase: "start",
          toolUseId: toolCall.toolUseId,
          args: toolCall.args as JsonValue | undefined,
          displayArgs: toolCall.displayArgs as JsonValue | undefined,
          createdAt: now,
        });
      }
      upsertNewestHistoryItems(queryClient, piSessionId, items);
      conversationState.finishMessage(piSessionId);
      return;
    }

    if (message.type === "stream_surfaced") {
      const surfacedMessage: ChatTimelineMessage = {
        ...message.message,
        streamId: message.message.streamId ?? message.streamId,
        streamName: message.message.streamName ?? message.streamName,
      };
      if (!surfacedMessage.content.trim() && !surfacedMessage.images?.length) return;
      queryClient.setQueryData<ChatTimelineMessage[]>(surfaceQueryKey, (old) => {
        const index = old?.findIndex((item) => item.id === surfacedMessage.id) ?? -1;
        if (index < 0) return [...(old ?? []), surfacedMessage];
        const next = [...(old ?? [])];
        next[index] = surfacedMessage;
        return next;
      });
      return;
    }

    if (message.type === "tool_execution_update") {
      conversationState.tool(piSessionId, {
        toolUseId: message.toolUseId,
        pending: true,
        partialResult: message.partialResult,
      });
      return;
    }

    if (message.type === "tool_execution_start") {
      conversationState.tool(piSessionId, { toolUseId: message.toolUseId, pending: true });
      return;
    }

    if (message.type === "tool_execution_end") {
      conversationState.tool(piSessionId, {
        toolUseId: message.toolUseId,
        pending: false,
        partialResult: message.result,
        isError: message.isError,
      });
      return;
    }

    if (message.type === "tool_result") {
      upsertNewestHistoryItems(queryClient, piSessionId, [message.item]);
      if (message.item.toolUseId) {
        conversationState.dropTool(piSessionId, message.item.toolUseId);
      }
      return;
    }

    if (message.type === "turn_end") {
      streamingUiDebug(
        "[debug][ws-bridge] turn_end: clearing transient state for session=%s",
        piSessionId,
      );
      conversationState.clear(piSessionId);
      return;
    }

    if (message.type === "agent_end") {
      conversationState.clear(piSessionId);
      if (message.aborted) void reloadHistory(piSessionId);
    }
  });

  let previousConnectionState = wsClient.connectionState;
  const unsubscribeConnection = wsClient.subscribeConnection((state) => {
    const previous = previousConnectionState;
    previousConnectionState = state;
    if (state === "connected" && (previous === "disconnected" || previous === "reconnecting")) {
      queryClient.invalidateQueries({ queryKey: ["status"] });
      queryClient.invalidateQueries({ queryKey: surfaceQueryKey });
    }
  });

  return () => {
    unsubscribeMessages();
    unsubscribeConnection();
  };
}
