import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useCallback } from "react";
import { statusQueryOptions, streamsHistoryInfiniteQueryOptions } from "~/lib/queries";
import type { ChatTimelineItem, ImageAttachment } from "~/lib/types";
import { useWsConnectionState } from "~/lib/ws-connection-store";

export type SendUserMessageOptions = {
  images?: ImageAttachment[];
  clientMessageId?: string;
};

const rootApi = getRouteApi("__root__");
const EMPTY_TIMELINE: ChatTimelineItem[] = [];

export function useStreamsChat(piSessionId: string | undefined) {
  const { sendMessage, apiClient, wsConnectionStore } = rootApi.useRouteContext();

  const {
    data: timeline = EMPTY_TIMELINE,
    error,
    fetchPreviousPage,
    hasPreviousPage,
    isFetchingPreviousPage,
  } = useInfiniteQuery(streamsHistoryInfiniteQueryOptions(piSessionId));
  const loadPreviousPage = useCallback(() => {
    void fetchPreviousPage();
  }, [fetchPreviousPage]);
  const connectionState = useWsConnectionState(wsConnectionStore);

  const { data: status } = useQuery(statusQueryOptions(apiClient));
  const isSessionBusy = (() => {
    if (!piSessionId || !status?.piAgent) return false;
    if (status.piAgent.default?.piSessionId === piSessionId) return !!status.piAgent.default.busy;
    return !!status.piAgent.orchestrators?.find((o) => o.piSessionId === piSessionId)?.busy;
  })();

  const effectivePiSessionId = piSessionId ?? "default";

  const onSendMessage = useCallback(
    (text: string, options?: SendUserMessageOptions) => {
      const trimmed = text.trim();
      const targetsDefault = trimmed === "/reload" || trimmed.startsWith("/new-stream");
      const target = targetsDefault ? undefined : piSessionId;
      return sendMessage(text, {
        images: options?.images,
        targetPiSessionId: target,
        clientMessageId: options?.clientMessageId,
      });
    },
    [sendMessage, piSessionId],
  );

  if (error) throw error;

  return {
    timeline,
    connectionState,
    onSendMessage,
    effectivePiSessionId,
    isSessionBusy,
    loadPreviousPage,
    hasPreviousPage,
    isFetchingPreviousPage,
  };
}
