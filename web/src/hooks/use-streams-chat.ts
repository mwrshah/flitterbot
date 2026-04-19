import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useCallback } from "react";
import { statusQueryOptions, streamsHistoryQueryOptions } from "~/lib/queries";
import type { ChatTimelineItem, ImageAttachment } from "~/lib/types";
import { useWsConnectionState } from "~/lib/ws-connection-store";

const rootApi = getRouteApi("__root__");

/**
 * Shared hook for Streams chat routes (default + per-session).
 * Pulls timeline, connection state, and sendMessage from
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
  const connectionState = useWsConnectionState(wsConnectionStore);

  const { data: status } = useQuery(statusQueryOptions(apiClient));
  const isSessionBusy = (() => {
    if (!piSessionId || !status?.piAgent) return false;
    if (status.piAgent.default?.piSessionId === piSessionId) return !!status.piAgent.default.busy;
    return !!status.piAgent.orchestrators?.find((o) => o.piSessionId === piSessionId)?.busy;
  })();

  const effectivePiSessionId = piSessionId ?? "default";

  const onSendMessage = useCallback(
    (text: string, images?: ImageAttachment[], modelId?: string) => {
      // /clear and /reload always target the current default session, regardless
      // of what the UI thinks the piSessionId is. Strip the target so backend
      // routes via getDefault() — avoids stale ID after the reset/reload.
      const trimmed = text.trim();
      const target = trimmed === "/clear" || trimmed === "/reload" ? undefined : piSessionId;
      return sendMessage(text, images, target, modelId ? { modelId } : undefined);
    },
    [sendMessage, piSessionId],
  );

  return {
    timeline,
    connectionState,
    onSendMessage,
    effectivePiSessionId,
    isSessionBusy,
  };
}
