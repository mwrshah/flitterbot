import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useCallback, useSyncExternalStore } from "react";
import {
  connectionStateQueryOptions,
  piHistoryQueryOptions,
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
 * Shared hook for Pi chat routes (default + per-session).
 * Pulls timeline, status pills, connection state, and sendMessage from
 * TanStack Query cache and router context — no imperative subscriptions.
 */
export function usePiChat(sessionId: string | undefined, loaderHistory: ChatTimelineItem[]) {
  const isClient = useIsClient();
  const queryClient = useQueryClient();
  const { sendMessage, apiClient } = rootApi.useRouteContext();

  const { data: timeline = loaderHistory } = useQuery(
    piHistoryQueryOptions(sessionId, undefined, queryClient),
  );
  const { data: statusPills = [] } = useQuery(statusPillsQueryOptions(sessionId ?? "default"));
  const { data: rawConnectionState = "disconnected" as ConnectionState } = useQuery(
    connectionStateQueryOptions(),
  );
  const connectionState = isClient ? rawConnectionState : ("disconnected" as ConnectionState);

  const { data: status } = useQuery(statusQueryOptions(apiClient));
  const isSessionBusy = (() => {
    if (!sessionId || !status?.pi) return false;
    if (status.pi.default?.sessionId === sessionId) return !!status.pi.default.busy;
    return !!status.pi.orchestrators?.find((o) => o.sessionId === sessionId)?.busy;
  })();

  const effectiveSessionId = sessionId ?? "default";

  const onSendMessage = useCallback(
    (text: string, images?: ImageAttachment[]) =>
      sendMessage(text, images, sessionId),
    [sendMessage, sessionId],
  );

  return { timeline, statusPills, connectionState, onSendMessage, effectiveSessionId, isSessionBusy };
}
