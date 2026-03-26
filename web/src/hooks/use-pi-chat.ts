import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useCallback, useSyncExternalStore } from "react";
import {
  connectionStateQueryOptions,
  piHistoryQueryOptions,
  statusPillsQueryOptions,
} from "~/lib/queries";
import type { ChatTimelineItem, ConnectionState, DeliveryMode, ImageAttachment } from "~/lib/types";

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
  const { sendMessage } = rootApi.useRouteContext();

  const { data: timeline = loaderHistory } = useQuery(piHistoryQueryOptions(sessionId));
  const { data: statusPills = [] } = useQuery(statusPillsQueryOptions(sessionId ?? "default"));
  const { data: rawConnectionState = "disconnected" as ConnectionState } = useQuery(
    connectionStateQueryOptions(),
  );
  const connectionState = isClient ? rawConnectionState : ("disconnected" as ConnectionState);

  const effectiveSessionId = sessionId ?? "default";

  const onSendMessage = useCallback(
    (text: string, deliveryMode: DeliveryMode, images?: ImageAttachment[]) =>
      sendMessage(text, deliveryMode, images, sessionId),
    [sendMessage, sessionId],
  );

  return { timeline, statusPills, connectionState, onSendMessage, effectiveSessionId };
}
