import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Badge } from "~/components/ui/badge";
import { MessageInput } from "~/components/ui/message-input";
import { useStickToBottom } from "~/hooks/use-stick-to-bottom";
import {
  buildStreamingAssistantMessage,
  pendingToolCallsFromTimeline,
  timelineToAgentMessages,
} from "~/lib/pi-web-ui-bridge";
import type { ChatTimelineItem, ConnectionState, DeliveryMode, ImageAttachment } from "~/lib/types";
import { PiMessageList } from "./pi-message-list";
import { PiStreamingMessage } from "./pi-streaming-message";

type StatusPill = { id: string; label: string; variant?: "info" | "error" };

const emptySubscribe = () => () => {};
const useIsClient = () =>
  useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );

function connectionLabel(state: ConnectionState): string {
  switch (state) {
    case "connected":
      return "Live";
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "stub":
      return "Stub";
    default:
      return "Offline";
  }
}

function connectionVariant(state: ConnectionState): "success" | "warning" | "muted" | "default" {
  switch (state) {
    case "connected":
      return "success";
    case "connecting":
    case "reconnecting":
      return "warning";
    default:
      return "muted";
  }
}

type ChatPanelProps = {
  timeline: ChatTimelineItem[];
  streamingText: string | null;
  streamingMessageId?: string | null;
  statusPills: StatusPill[];
  connectionState: ConnectionState;
  onSendMessage: (
    text: string,
    deliveryMode: DeliveryMode,
    images?: ImageAttachment[],
  ) => Promise<void>;
};

export function ChatPanel({
  timeline,
  streamingText,
  streamingMessageId: _streamingMessageId,
  statusPills,
  connectionState,
  onSendMessage,
}: ChatPanelProps) {
  const isClient = useIsClient();
  const rootApi = getRouteApi("__root__");
  const { apiClient } = rootApi.useRouteContext();
  const { data: skillsData } = useQuery({
    queryKey: ["skills"],
    queryFn: () => apiClient.listSkills(),
    staleTime: 5 * 60 * 1000,
  });
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>("followUp");
  const [isSending, setIsSending] = useState(false);

  const { viewportRef, engageAndScroll } = useStickToBottom();

  const agentMessages = useMemo(() => timelineToAgentMessages(timeline), [timeline]);

  const pendingToolCalls = useMemo(() => pendingToolCallsFromTimeline(timeline), [timeline]);

  const streamingMessage = useMemo(
    () => (streamingText ? buildStreamingAssistantMessage(streamingText) : null),
    [streamingText],
  );

  const handleSubmit = useCallback(
    async (text: string, images?: ImageAttachment[]) => {
      setIsSending(true);
      engageAndScroll();
      try {
        await onSendMessage(text, deliveryMode, images);
      } finally {
        setIsSending(false);
      }
    },
    [onSendMessage, deliveryMode, engageAndScroll],
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border shrink-0">
        <h1 className="text-sm font-semibold text-foreground">Pi</h1>
        <div className="flex items-center gap-2">
          {statusPills.length > 0 && (
            <div className="flex items-center gap-1.5">
              {statusPills.map((pill) => (
                <Badge key={pill.id} variant={pill.variant === "error" ? "error" : "muted"}>
                  {pill.label}
                </Badge>
              ))}
            </div>
          )}
          {isClient && (
            <Badge variant={connectionVariant(connectionState)}>
              {connectionLabel(connectionState)}
            </Badge>
          )}
        </div>
      </div>

      {/* Message area — fills all available space */}
      <div ref={viewportRef} className="flex-1 overflow-auto px-6 py-4 space-y-3">
        <PiMessageList
          messages={agentMessages}
          isStreaming={streamingText !== null}
          pendingToolCalls={pendingToolCalls}
        />
        <PiStreamingMessage message={streamingMessage} visible={streamingText !== null} />
      </div>

      <MessageInput
        deliveryMode={deliveryMode}
        onDeliveryModeChange={setDeliveryMode}
        isSending={isSending}
        onSubmit={handleSubmit}
        skills={skillsData?.items}
        rows={2}
      />
    </div>
  );
}
