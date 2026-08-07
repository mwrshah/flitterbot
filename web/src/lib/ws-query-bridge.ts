import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  createSurfaceLiveUpdater,
  latestHistoryPosition,
  refreshHistorySnapshot,
  surfaceQueryKey,
  upsertNewestHistoryItems,
} from "~/lib/conversation-history";
import { conversationState } from "~/lib/conversation-state";
import { streamingUiDebug } from "~/lib/debug-log";
import { surfaceTimelineInfiniteQueryOptions } from "~/lib/queries";
import type { ChatTimelineMessage, StatusQueryData } from "~/lib/types";
import type { FlitterbotWsClient } from "~/lib/ws";
import type { ConversationEventPosition } from "../../../src/contracts/websocket.ts";

export function setupWsQueryBridge(deps: {
  queryClient: QueryClient;
  wsClient: FlitterbotWsClient;
}): () => void {
  const { queryClient, wsClient } = deps;
  const recovering = new Set<string>();
  const surfaceLiveUpdater = createSurfaceLiveUpdater(queryClient, () =>
    queryClient.ensureInfiniteQueryData(surfaceTimelineInfiniteQueryOptions()),
  );

  const reloadHistory = async (piSessionId: string, resumePosition?: ConversationEventPosition) => {
    if (recovering.has(piSessionId)) return;
    recovering.add(piSessionId);
    wsClient.pauseSessionSubscription(piSessionId);
    conversationState.clear(piSessionId);

    try {
      await refreshHistorySnapshot(queryClient, piSessionId);
      if (wsClient.activeSubscriptionPiSessionId() !== piSessionId) return;
      wsClient.setResumePosition(
        piSessionId,
        resumePosition ?? latestHistoryPosition(queryClient, piSessionId),
      );
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

    if (message.type === "compaction_start" || message.type === "compaction_end") {
      const isCompacting = message.type === "compaction_start";
      void queryClient.invalidateQueries({ queryKey: ["status"] });
      queryClient.setQueryData<StatusQueryData>(["status"], (status) => {
        if (!status?.piAgent) return status;
        if (!message.piSessionId) return status;
        return {
          ...status,
          piAgent: {
            ...status.piAgent,
            default:
              status.piAgent.default?.piSessionId === message.piSessionId
                ? { ...status.piAgent.default, isCompacting }
                : status.piAgent.default,
            orchestrators: status.piAgent.orchestrators.map((session) =>
              session.piSessionId === message.piSessionId ? { ...session, isCompacting } : session,
            ),
          },
        };
      });
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

    if (message.type === "conversation_reset") {
      void queryClient.invalidateQueries({ queryKey: ["status"] });
      void reloadHistory(piSessionId, message.position);
      return;
    }

    if (message.type === "history_rewritten") {
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
      upsertNewestHistoryItems(queryClient, piSessionId, message.items);
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
      void surfaceLiveUpdater.update(surfacedMessage);
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
      conversationState.dropTool(piSessionId, message.item.toolUseId);
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
    surfaceLiveUpdater.dispose();
    unsubscribeMessages();
    unsubscribeConnection();
  };
}
