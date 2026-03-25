import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { type FormEvent, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Badge } from "~/components/ui/badge";
import { MessageInput } from "~/components/ui/message-input";
import { useStickToBottom } from "~/hooks/use-stick-to-bottom";
import { piSessionStore } from "~/lib/pi-session-store";
import {
  buildStreamingAssistantMessage,
  pendingToolCallsFromTimeline,
  timelineToAgentMessages,
} from "~/lib/pi-web-ui-bridge";
import { StreamChunker } from "~/lib/stream-chunker";
import type { ChatTimelineItem, ConnectionState, DeliveryMode, ImageAttachment } from "~/lib/types";
import { PiMessageList } from "./pi-message-list";
import { PiStreamingMessage, type PiStreamingMessageHandle } from "./pi-streaming-message";

const DevStreamTuner = import.meta.env.DEV
  ? lazy(() => import("./dev-stream-tuner").then((m) => ({ default: m.DevStreamTuner })))
  : null;

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
  sessionId: string | undefined;
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
  sessionId,
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
  const [isStreaming, setIsStreaming] = useState(false);

  const { viewportRef, engageAndScroll } = useStickToBottom();

  const agentMessages = useMemo(() => timelineToAgentMessages(timeline), [timeline]);

  const pendingToolCalls = useMemo(() => pendingToolCallsFromTimeline(timeline), [timeline]);

  const streamingRef = useRef<PiStreamingMessageHandle>(null);

  // Register streaming callback — fires synchronously from WS handler, no React in the loop.
  // StreamChunker buffers deltas and drains them on a smooth interval to avoid jittery rendering.
  useEffect(() => {
    if (!sessionId) return;

    // Shared mutable state across text + thinking callbacks
    let currentThinking: string | null = null;
    let currentChunkedText: string = "";

    const chunker = new StreamChunker({
      onChunk: (fullText) => {
        currentChunkedText = fullText;
        streamingRef.current?.update(
          buildStreamingAssistantMessage(fullText, currentThinking ?? undefined),
        );
      },
    });

    let streaming = false;
    let seenLen = 0;

    piSessionStore.onStreamingDelta(sessionId, (text, _messageId) => {
      if (text === null) {
        chunker.flush();
        streamingRef.current?.clear();
        streaming = false;
        seenLen = 0;
        currentChunkedText = "";
        setIsStreaming(false);
        return;
      }
      // Store callback sends full accumulated text — push only the new portion
      if (text.length > seenLen) {
        chunker.push(text.slice(seenLen));
        seenLen = text.length;
      }
      if (!streaming) {
        streaming = true;
        setIsStreaming(true);
      }
    });

    piSessionStore.onStreamingThinkingDelta(sessionId, (thinking, _messageId) => {
      if (thinking === null) {
        currentThinking = null;
        return;
      }
      currentThinking = thinking;
      // Update streaming message immediately so thinking renders even before text starts
      if (!streaming) {
        streaming = true;
        setIsStreaming(true);
      }
      streamingRef.current?.update(
        buildStreamingAssistantMessage(currentChunkedText, currentThinking),
      );
    });

    // Expose chunker for dev tuning overlay
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__streamChunker = chunker;
    }

    return () => {
      piSessionStore.offStreamingDelta(sessionId);
      piSessionStore.offStreamingThinkingDelta(sessionId);
      chunker.destroy();
      if (import.meta.env.DEV) {
        delete (window as unknown as Record<string, unknown>).__streamChunker;
      }
    };
  }, [sessionId]);

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
          isStreaming={isStreaming}
          pendingToolCalls={pendingToolCalls}
        />
        <PiStreamingMessage ref={streamingRef} />
      </div>

      <MessageInput
        deliveryMode={deliveryMode}
        onDeliveryModeChange={setDeliveryMode}
        isSending={isSending}
        onSubmit={handleSubmit}
        skills={skillsData?.items}
        rows={2}
      />
      {DevStreamTuner && (
        <Suspense fallback={null}>
          <DevStreamTuner />
        </Suspense>
      )}
    </div>
  );
}
