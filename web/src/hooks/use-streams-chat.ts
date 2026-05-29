import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useCallback } from "react";
import { statusQueryOptions, streamsHistoryQueryOptions } from "~/lib/queries";
import type { ChatTimelineItem, ImageAttachment } from "~/lib/types";
import { useWsConnectionState } from "~/lib/ws-connection-store";

export type SendUserMessageOptions = {
  images?: ImageAttachment[];
  clientMessageId?: string;
};

const rootApi = getRouteApi("__root__");

export function useStreamsChat(piSessionId: string | undefined, loaderHistory: ChatTimelineItem[]) {
  const { sendMessage, apiClient, wsConnectionStore } = rootApi.useRouteContext();

  const { data: timeline = [] } = useQuery({
    ...streamsHistoryQueryOptions(piSessionId),
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
    (text: string, options?: SendUserMessageOptions) => {
      const trimmed = text.trim();
      const targetsDefault =
        trimmed === "/clear" || trimmed === "/reload" || trimmed.startsWith("/new-stream");
      const target = targetsDefault ? undefined : piSessionId;
      return sendMessage(text, {
        images: options?.images,
        targetPiSessionId: target,
        clientMessageId: options?.clientMessageId,
      });
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
