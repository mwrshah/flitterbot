import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useCallback } from "react";
import { useConnectionState } from "~/hooks/use-connection-state";
import {
  statusPillsQueryOptions,
  statusQueryOptions,
  streamsHistoryQueryOptions,
} from "~/lib/queries";
import type { ChatTimelineItem, ImageAttachment } from "~/lib/types";

const rootApi = getRouteApi("__root__");

/**
 * Shared hook for Streams chat routes (default + per-session).
 * Pulls timeline, status pills, connection state, and sendMessage from
 * TanStack Query cache and router context — no imperative subscriptions.
 */
export function useStreamsChat(piSessionId: string | undefined, loaderHistory: ChatTimelineItem[]) {
  const { sendMessage, apiClient, wsClient } = rootApi.useRouteContext();

  const { data: timeline = loaderHistory } = useQuery(streamsHistoryQueryOptions(piSessionId));
  const { data: statusPills = [] } = useQuery(statusPillsQueryOptions(piSessionId ?? "default"));
  // useSyncExternalStore subscribes directly to the WS client — SSR-safe via
  // getServerSnapshot. See: features/tanstack-patterns/references/query.md (lines 69-71)
  // See: features/tanstack-patterns/references/ssr.md (lines 63-65)
  const connectionState = useConnectionState(wsClient);

  const { data: status } = useQuery(statusQueryOptions(apiClient));
  const isSessionBusy = (() => {
    if (!piSessionId || !status?.streamAgent) return false;
    if (status.streamAgent.default?.piSessionId === piSessionId)
      return !!status.streamAgent.default.busy;
    return !!status.streamAgent.orchestrators?.find((o) => o.piSessionId === piSessionId)?.busy;
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
