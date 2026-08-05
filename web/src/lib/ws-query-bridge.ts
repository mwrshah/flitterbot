import type { QueryClient } from "@tanstack/react-query";
import type { AnyRouter } from "@tanstack/react-router";
import { toast } from "sonner";
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
      if (message.piSessionId) {
        queryClient.invalidateQueries({
          queryKey: conversationState.historyQueryKey(message.piSessionId),
        });
      }
      toast.error(message.message);
      return;
    }

    if (message.type === "resources_reloaded") {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      toast.success("Resources reloaded");
      return;
    }

    if (!piSessionId) return;

    if (message.type === "conversation_reset") {
      conversationState.reset(piSessionId, message.position);
      queryClient.invalidateQueries({ queryKey: conversationState.historyQueryKey(piSessionId) });
      return;
    }

    const observation = conversationState.observeEvent(piSessionId, message);
    if (observation === "duplicate" || observation === "recovering") return;
    if (observation === "gap") {
      conversationState.clear(piSessionId);
      queryClient.invalidateQueries({ queryKey: conversationState.historyQueryKey(piSessionId) });
      wsClient.resumeSessionSubscription();
      return;
    }

    if (message.type === "history_rewritten") {
      conversationState.historyRewritten(piSessionId);
      queryClient.invalidateQueries({ queryKey: conversationState.historyQueryKey(piSessionId) });
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
      const isUser = msg.role === "user";

      if (hasContent || message.toolCalls?.length) {
        const now = new Date().toISOString();

        const committed: ChatTimelineMessage | undefined = hasContent
          ? blocks
            ? { ...msg, blocks }
            : msg
          : undefined;

        const toolItems: ChatTimelineTool[] = (message.toolCalls ?? []).map((tc) => ({
          id: `tool-${tc.toolUseId}-start`,
          kind: "tool",
          tool: tc.toolName,
          phase: "start",
          toolUseId: tc.toolUseId,
          args: tc.args as JsonValue | undefined,
          displayArgs: tc.displayArgs as JsonValue | undefined,
          createdAt: now,
        }));

        conversationState.commitMessage(
          queryClient,
          piSessionId,
          committed,
          isUser ? msg.id : undefined,
          toolItems,
          message.position,
        );
      }

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

      conversationState.commitSurface(queryClient, surfacedMessage);
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
      conversationState.tool(piSessionId, {
        toolUseId: message.toolUseId,
        pending: true,
      });
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
      conversationState.appendLiveItem(queryClient, piSessionId, message.item, message.position);

      if (message.item.toolUseId) {
        conversationState.dropTool(piSessionId, message.item.toolUseId);
      }
      return;
    }

    if (message.type === "turn_end") {
      streamingUiDebug(
        "[debug][ws-bridge] turn_end: calling clearSession for session=%s",
        piSessionId,
      );
      conversationState.clear(piSessionId);
      conversationState.settleTurn(queryClient, piSessionId);
      return;
    }

    if (message.type === "agent_end") {
      conversationState.clear(piSessionId);
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
      queryClient.invalidateQueries({ queryKey: conversationState.surfaceQueryKey });
      router.invalidate();
    }
  });

  return () => {
    unsubscribeMessages();
    unsubscribeConnection();
  };
}
