import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useCallback, useSyncExternalStore } from "react";
import {
  connectionStateQueryOptions,
  statusPillsQueryOptions,
  statusQueryOptions,
  streamsHistoryQueryOptions,
} from "~/lib/queries";
import type { ChatTimelineItem, ConnectionState, ImageAttachment } from "~/lib/types";

const rootApi = getRouteApi("__root__");

const emptySubscribe = () => () => {};
const useIsClient = () =>
  useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );

/**
 * Shared hook for Streams chat routes (default + per-session).
 * Pulls timeline, status pills, connection state, and sendMessage from
 * TanStack Query cache and router context — no imperative subscriptions.
 */
export function useStreamsChat(piSessionId: string | undefined, loaderHistory: ChatTimelineItem[]) {
  const isClient = useIsClient();
  const { sendMessage, apiClient } = rootApi.useRouteContext();

  const { data: timeline = loaderHistory } = useQuery(streamsHistoryQueryOptions(piSessionId));
  const { data: statusPills = [] } = useQuery(statusPillsQueryOptions(piSessionId ?? "default"));
  const { data: rawConnectionState = "disconnected" as ConnectionState } = useQuery(
    connectionStateQueryOptions(),
  );
  const connectionState = isClient ? rawConnectionState : ("disconnected" as ConnectionState);

  const { data: status } = useQuery(statusQueryOptions(apiClient));
  const isSessionBusy = (() => {
    if (!piSessionId || !status?.piAgent) return false;
    if (status.piAgent.default?.piSessionId === piSessionId)
      return !!status.piAgent.default.busy;
    return !!status.piAgent.orchestrators?.find((o) => o.piSessionId === piSessionId)?.busy;
  })();

  const effectivePiSessionId = piSessionId ?? "default";

  const onSendMessage = useCallback(
    (text: string, images?: ImageAttachment[]) => sendMessage(text, images, piSessionId),
    [sendMessage, piSessionId],
  );

  return {
    timeline,
    statusPills,
    connectionState,
    onSendMessage,
    effectivePiSessionId,
    isSessionBusy,
  };
}
