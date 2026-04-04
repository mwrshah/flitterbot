import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Badge } from "~/components/common/badge";
import { Button } from "~/components/common/button";
import { MessageInput } from "~/components/common/message-input";
import { HorizontalResizeHandle, Panel, PanelGroup } from "~/components/common/resizable";
import { useAgentMessages } from "~/hooks/use-agent-messages";
import { useStickToBottom } from "~/hooks/use-stick-to-bottom";
import { parsePanelLayout, useUserConfig } from "~/hooks/use-user-config";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import type { StatusPill } from "~/lib/queries";
import { streamingPerf } from "~/lib/streaming-perf";
import { streamingStore } from "~/lib/streaming-store";
import type { ChatTimelineItem, ImageAttachment } from "~/lib/types";
import { StreamsMessageList, type StreamsMessageListHandle } from "./streams-message-list";

const emptySubscribe = () => () => {};
const useIsClient = () =>
  useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );

const CHAT_LAYOUT_KEY = "panel:chat-layout";
const CHAT_LAYOUT_DEFAULT: Record<string, number> = { feed: 85, input: 15 };

type ChatPanelProps = {
  piSessionId: string;
  timeline: ChatTimelineItem[];
  statusPills: StatusPill[];
  isSessionBusy: boolean;
  onSendMessage: (text: string, images?: ImageAttachment[]) => Promise<void>;
  streamId?: string;
  streamName?: string;
  isStreamClosed?: boolean;
};

export function ChatPanel({
  piSessionId,
  timeline,
  statusPills,
  isSessionBusy,
  onSendMessage,
  streamId,
  streamName,
  isStreamClosed,
}: ChatPanelProps) {
  useWhyDidYouRender("ChatPanel", {
    piSessionId,
    timeline,
    statusPills,
    isSessionBusy,
    streamId,
    isStreamClosed,
  });
  const isClient = useIsClient();
  const { config, setConfig } = useUserConfig();
  const chatLayout = parsePanelLayout(config, CHAT_LAYOUT_KEY, CHAT_LAYOUT_DEFAULT);
  const rootApi = getRouteApi("__root__");
  const { apiClient } = rootApi.useRouteContext();
  const queryClient = useQueryClient();
  const messageListRef = useRef<StreamsMessageListHandle>(null);
  const { data: skillsData } = useQuery({
    queryKey: ["skills"],
    queryFn: () => apiClient.listSkills(),
    staleTime: 5 * 60 * 1000,
  });
  const isSessionActive = isSessionBusy;

  const interruptMutation = useMutation({
    mutationFn: () => apiClient.interruptPiSession(piSessionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["status"] }),
  });

  const reopenMutation = useMutation({
    mutationFn: () => apiClient.reopenStream(streamId!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["status"] }),
  });

  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([]);

  const [isSending, setIsSending] = useState(false);
  const agentMessages = useAgentMessages(timeline);

  const { viewportRef, scrollToBottom, isAtBottomRef, engageAndScroll } = useStickToBottom({
    initialScrollWhen: agentMessages.length > 0,
    initialScrollKey: piSessionId,
  });

  const settleToBottomIfPinned = useCallback(() => {
    if (!isAtBottomRef.current) return;
    const scrollToken = streamingPerf.beginScroll();
    scrollToBottom();
    streamingPerf.endScroll(scrollToken);
  }, [isAtBottomRef, scrollToBottom]);

  // Wire streaming deltas from the streaming store to the Lit web component.
  // We drive scroll explicitly here instead of using MutationObserver /
  // ResizeObserver so streaming updates do not create an observer-driven
  // scroll feedback loop.
  useEffect(() => {
    streamingStore.onStreamingDelta(
      piSessionId,
      (text, thinking, isThinkingStreaming, messageId) => {
        if (messageId != null) {
          messageListRef.current?.updateStreaming(
            {
              role: "assistant",
              content: [
                ...(thinking ? [{ type: "thinking" as const, thinking }] : []),
                ...(text ? [{ type: "text" as const, text }] : []),
              ],
              api: "openai-responses",
              provider: "openai",
              model: "",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop",
              timestamp: Date.now(),
            },
            isThinkingStreaming,
          );
          settleToBottomIfPinned();
        } else {
          console.log(
            "[debug][ChatPanel] clearStreaming() — messageId=null, streaming store fired end-of-stream for session=%s",
            piSessionId,
          );
          messageListRef.current?.clearStreaming();
        }
      },
    );
    return () => {
      streamingStore.offStreamingDelta(piSessionId);
      messageListRef.current?.clearStreaming();
    };
  }, [piSessionId, settleToBottomIfPinned]);

  const addImageFiles = useCallback((files: FileList | File[]) => {
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!imageFiles.length) return;
    for (const file of imageFiles) {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(",")[1];
        if (base64) {
          setPendingImages((prev) => [...prev, { data: base64, mimeType: file.type }]);
        }
      };
      reader.readAsDataURL(file);
    }
  }, []);

  const removeImage = useCallback((index: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // Ref for stable handleSubmit closure
  const pendingImagesRef = useRef(pendingImages);
  useEffect(() => {
    pendingImagesRef.current = pendingImages;
  });

  const handleSubmit = useCallback(
    async (text: string) => {
      const images = pendingImagesRef.current.length ? [...pendingImagesRef.current] : undefined;
      if (!text && !images?.length) return;

      setIsSending(true);
      setPendingImages([]);
      engageAndScroll();

      try {
        await onSendMessage(text || "(image)", images);
      } finally {
        setIsSending(false);
      }
    },
    [engageAndScroll, onSendMessage],
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex items-center justify-between px-6 py-2 border-b border-border shrink-0 min-h-11">
        <h1 className="text-sm font-semibold text-foreground">Streams</h1>
        <div className="flex items-center gap-2">
          {isClient && statusPills.length > 0 && (
            <div className="flex items-center gap-1.5">
              {statusPills.map((pill) => (
                <Badge key={pill.id} variant={pill.variant === "error" ? "error" : "muted"}>
                  {pill.label}
                </Badge>
              ))}
            </div>
          )}
          {isClient && isSessionActive && (
            <Button
              variant="destructive"
              size="sm"
              className="h-6 px-2 text-[11px]"
              disabled={interruptMutation.isPending}
              onClick={() => interruptMutation.mutate()}
            >
              {interruptMutation.isPending ? "Stopping..." : "Stop"}
            </Button>
          )}
          {isClient && !isSessionActive && isStreamClosed && streamId && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px]"
              disabled={reopenMutation.isPending}
              onClick={() => reopenMutation.mutate()}
            >
              <RotateCcw className="size-3" />
              {reopenMutation.isPending ? "Reopening..." : "Reopen"}
            </Button>
          )}
        </div>
      </div>

      <PanelGroup
        orientation="vertical"
        className="flex-1 min-h-0"
        defaultLayout={chatLayout}
        onLayoutChanged={(layout) => setConfig(CHAT_LAYOUT_KEY, JSON.stringify(layout))}
      >
        {/* Message area */}
        <Panel id="feed" defaultSize="85%" minSize="20%">
          <div
            ref={viewportRef}
            data-scroll-container="main"
            className="h-full overflow-auto px-6 py-4 space-y-3"
          >
            <StreamsMessageList
              ref={messageListRef}
              messages={agentMessages}
              onMessagesRendered={settleToBottomIfPinned}
            />
          </div>
        </Panel>

        <HorizontalResizeHandle />

        <Panel id="input" defaultSize="15%" minSize="9%">
          <MessageInput
            isSending={isSending}
            onSubmit={handleSubmit}
            pendingImages={pendingImages}
            onAddImages={addImageFiles}
            onRemoveImage={removeImage}
            skills={skillsData?.items}
            placeholder={streamName ? `Message ${streamName}...` : "Message streams..."}
            fillHeight
            autoFocus
            streamId={streamId}
          />
        </Panel>
      </PanelGroup>
    </div>
  );
}
