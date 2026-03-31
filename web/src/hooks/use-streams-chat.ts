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
export function useStreamsChat(sessionId: string | undefined, loaderHistory: ChatTimelineItem[]) {
  const isClient = useIsClient();
  const { sendMessage, apiClient } = rootApi.useRouteContext();

  const { data: timeline = loaderHistory } = useQuery(streamsHistoryQueryOptions(sessionId));
  const { data: statusPills = [] } = useQuery(statusPillsQueryOptions(sessionId ?? "default"));
  const { data: rawConnectionState = "disconnected" as ConnectionState } = useQuery(
    connectionStateQueryOptions(),
  );
  const connectionState = isClient ? rawConnectionState : ("disconnected" as ConnectionState);

  const { data: status } = useQuery(statusQueryOptions(apiClient));
  const isSessionBusy = (() => {
    if (!sessionId || !status?.streamsAgent) return false;
    if (status.streamsAgent.default?.sessionId === sessionId)
      return !!status.streamsAgent.default.busy;
    return !!status.streamsAgent.orchestrators?.find((o) => o.sessionId === sessionId)?.busy;
  })();

  const effectiveSessionId = sessionId ?? "default";

  const onSendMessage = useCallback(
    (text: string, images?: ImageAttachment[]) => sendMessage(text, images, sessionId),
    [sendMessage, sessionId],
  );

  return {
    timeline,
    statusPills,
    connectionState,
    onSendMessage,
    effectiveSessionId,
    isSessionBusy,
  };
}
