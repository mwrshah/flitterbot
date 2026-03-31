import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useCallback, useSyncExternalStore } from "react";
import {
  connectionStateQueryOptions,
  streamsHistoryQueryOptions,
  statusPillsQueryOptions,
  statusQueryOptions,
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
    if (!sessionId || !status?.streams) return false;
    if (status.streams.default?.sessionId === sessionId) return !!status.streams.default.busy;
    return !!status.streams.orchestrators?.find((o) => o.sessionId === sessionId)?.busy;
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
