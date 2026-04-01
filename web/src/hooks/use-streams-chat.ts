import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useCallback } from "react";
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

  const { data: timeline = [] } = useQuery({
    ...streamsHistoryQueryOptions(piSessionId),
    // Stale-while-revalidate: render cached/loader history immediately, then
    // always revalidate session history in the background on mount/key change.
    initialData: loaderHistory,
    refetchOnMount: "always",
  });
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
