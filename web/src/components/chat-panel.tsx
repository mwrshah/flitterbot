import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { MessageInput } from "~/components/ui/message-input";
import { useAgentMessages } from "~/hooks/use-agent-messages";
import { useStickToBottom } from "~/hooks/use-stick-to-bottom";
import type { StatusPill } from "~/lib/queries";
import { streamingStore } from "~/lib/streaming-store";
import type { ChatTimelineItem, ImageAttachment } from "~/lib/types";
import { PiMessageList, type PiMessageListHandle } from "./pi-message-list";

const emptySubscribe = () => () => {};
const useIsClient = () =>
  useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );

type ChatPanelProps = {
  sessionId: string;
  timeline: ChatTimelineItem[];
  statusPills: StatusPill[];
  isSessionBusy: boolean;
  onSendMessage: (text: string, images?: ImageAttachment[]) => Promise<void>;
};

export function ChatPanel({
  sessionId,
  timeline,
  statusPills,
  isSessionBusy,
  onSendMessage,
}: ChatPanelProps) {
  const isClient = useIsClient();
  const rootApi = getRouteApi("__root__");
  const { apiClient } = rootApi.useRouteContext();
  const queryClient = useQueryClient();
  const messageListRef = useRef<PiMessageListHandle>(null);
  const { data: skillsData } = useQuery({
    queryKey: ["skills"],
    queryFn: () => apiClient.listSkills(),
    staleTime: 5 * 60 * 1000,
  });
  const isSessionActive = isSessionBusy;

  const interruptMutation = useMutation({
    mutationFn: () => apiClient.interruptPiSession(sessionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["status"] }),
  });

  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([]);

  const [isSending, setIsSending] = useState(false);

  const { viewportRef, engageAndScroll } = useStickToBottom();

  const agentMessages = useAgentMessages(timeline);

  // Wire streaming deltas from the streaming store to the Lit web component
  useEffect(() => {
    streamingStore.onStreamingDelta(sessionId, (text, thinking, isThinkingStreaming, messageId) => {
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
      } else {
        console.log("[debug][ChatPanel] clearStreaming() — messageId=null, streaming store fired end-of-stream for session=%s", sessionId);
        messageListRef.current?.clearStreaming();
      }
    });
    return () => {
      streamingStore.offStreamingDelta(sessionId);
    };
  }, [sessionId]);

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
      <div className="flex items-center justify-between px-6 py-3 border-b border-border shrink-0">
        <h1 className="text-sm font-semibold text-foreground">Pi</h1>
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
              disabled={interruptMutation.isPending}
              onClick={() => interruptMutation.mutate()}
            >
              {interruptMutation.isPending ? "Stopping..." : "Stop"}
            </Button>
          )}
        </div>
      </div>

      {/* Message area — fills all available space */}
      <div ref={viewportRef} className="flex-1 overflow-auto px-6 py-4 space-y-3">
        <PiMessageList ref={messageListRef} messages={agentMessages} />
      </div>

      <MessageInput

        isSending={isSending}
        onSubmit={handleSubmit}
        pendingImages={pendingImages}
        onAddImages={addImageFiles}
        onRemoveImage={removeImage}
        skills={skillsData?.items}
        rows={2}
      />
    </div>
  );
}
