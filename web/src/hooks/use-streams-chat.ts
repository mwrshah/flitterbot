import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { statusQueryOptions, streamsHistoryInfiniteQueryOptions } from "@/lib/queries";
import type { ImageAttachment } from "@/lib/types";
import { useWsConnectionState } from "@/lib/ws-connection-store";

export type SendUserMessageOptions = {
  images?: ImageAttachment[];
  clientMessageId?: string;
};

const rootApi = getRouteApi("__root__");

export function useStreamsChat(piSessionId: string | undefined) {
  const { sendMessage, apiClient, wsConnectionStore } = rootApi.useRouteContext();

  const { data, error, fetchPreviousPage, hasPreviousPage, isFetchingPreviousPage } =
    useInfiniteQuery(streamsHistoryInfiniteQueryOptions(piSessionId));
  const timeline = useMemo(() => {
    if (!data?.pages.length) return [];
    if (data.pages.length === 1) return data.pages[0]!.items;
    return data.pages.flatMap((page) => page.items);
  }, [data]);
  const newestPage = data?.pages.at(-1);
  const turnQueue = newestPage?.turnQueue ?? { version: 0, items: [] };
  const totalUserMessages = newestPage?.totalUserMessages ?? 0;
  const loadPreviousPage = useCallback(() => {
    void fetchPreviousPage();
  }, [fetchPreviousPage]);
  const connectionState = useWsConnectionState(wsConnectionStore);

  const { data: status } = useQuery(statusQueryOptions(apiClient));
  const sessionStatus = (() => {
    if (!piSessionId || !status?.piAgent) return undefined;
    if (status.piAgent.default?.piSessionId === piSessionId) return status.piAgent.default;
    return status.piAgent.orchestrators?.find((o) => o.piSessionId === piSessionId);
  })();
  const isSessionBusy = sessionStatus?.busy ?? false;
  const isSessionCompacting = sessionStatus?.isCompacting ?? false;
  const contextUsage = useMemo(() => {
    for (let index = timeline.length - 1; index >= 0; index--) {
      const item = timeline[index];
      if (
        item?.kind === "message" &&
        item.role === "assistant" &&
        item.usage &&
        item.usage.totalTokens > 0
      ) {
        return item.usage;
      }
    }
    return null;
  }, [timeline]);

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
    turnQueue,
    connectionState,
    onSendMessage,
    effectivePiSessionId,
    isSessionBusy,
    isSessionCompacting,
    contextUsage,
    totalUserMessages,
    loadPreviousPage,
    hasPreviousPage,
    isFetchingPreviousPage,
  };
}
