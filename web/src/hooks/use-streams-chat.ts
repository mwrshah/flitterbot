import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import {
  type StatusPill,
  statusPillsQueryOptions,
  statusQueryOptions,
  streamsHistoryQueryOptions,
} from "~/lib/queries";
import type { ChatTimelineItem, ImageAttachment } from "~/lib/types";
import { useWsConnectionState } from "~/lib/ws-connection-store";

const rootApi = getRouteApi("__root__");
const EMPTY_STATUS_PILLS: StatusPill[] = [];

/**
 * Shared hook for Streams chat routes (default + per-session).
 * Pulls timeline, status pills, connection state, and sendMessage from
 * TanStack Query cache and router context — no imperative subscriptions.
 */
export function useStreamsChat(piSessionId: string | undefined, loaderHistory: ChatTimelineItem[]) {
  const { sendMessage, apiClient, wsConnectionStore } = rootApi.useRouteContext();
  const queryClient = useQueryClient();
  const mountRef = useRef(false);

  // Debug: log cache state on mount and piSessionId change
  useEffect(() => {
    const queryKey = ["streams-history", piSessionId ?? "default", "agent"];
    const queryState = queryClient.getQueryState(queryKey);
    console.log("[useStreamsChat] mount/key change", {
      piSessionId,
      loaderHistoryLength: loaderHistory.length,
      isFirstMount: !mountRef.current,
      cacheState: {
        dataUpdatedAt: queryState?.dataUpdatedAt ? new Date(queryState.dataUpdatedAt).toISOString() : null,
        isFetching: queryState?.fetchStatus === "fetching",
        isStale: queryState?.dataUpdatedAt ? Date.now() - queryState.dataUpdatedAt > 0 : null,
        dataLength: Array.isArray(queryState?.data) ? queryState.data.length : null,
      },
    });
    mountRef.current = true;
  }, [piSessionId, queryClient, loaderHistory.length]);

  const { data: timeline = [], isFetching, isStale, dataUpdatedAt } = useQuery({
    ...streamsHistoryQueryOptions(piSessionId),
    // Stale-while-revalidate: render cached/loader history immediately, then
    // always revalidate session history in the background on mount/key change.
    initialData: loaderHistory,
    refetchOnMount: "always",
  });

  // Debug: log when query state changes
  useEffect(() => {
    console.log("[useStreamsChat] query state", {
      piSessionId,
      timelineLength: timeline.length,
      isFetching,
      isStale,
      dataUpdatedAt: dataUpdatedAt ? new Date(dataUpdatedAt).toISOString() : null,
    });
  }, [piSessionId, timeline.length, isFetching, isStale, dataUpdatedAt]);
  const { data: statusPills } = useQuery(statusPillsQueryOptions(piSessionId ?? "default"));
  const statusPillsStable = statusPills ?? EMPTY_STATUS_PILLS;
  const connectionState = useWsConnectionState(wsConnectionStore);

  const { data: status } = useQuery(statusQueryOptions(apiClient));
  const isSessionBusy = (() => {
    if (!piSessionId || !status?.piAgent) return false;
    if (status.piAgent.default?.piSessionId === piSessionId) return !!status.piAgent.default.busy;
    return !!status.piAgent.orchestrators?.find((o) => o.piSessionId === piSessionId)?.busy;
  })();

  const effectivePiSessionId = piSessionId ?? "default";

  const onSendMessage = useCallback(
    (text: string, images?: ImageAttachment[]) => sendMessage(text, images, piSessionId),
    [sendMessage, piSessionId],
  );

  return {
    timeline,
    statusPills: statusPillsStable,
    connectionState,
    onSendMessage,
    effectivePiSessionId,
    isSessionBusy,
  };
}
