import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { type FormEvent, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Badge } from "~/components/ui/badge";
import { MessageInput } from "~/components/ui/message-input";
import { useStickToBottom } from "~/hooks/use-stick-to-bottom";
import { timelineToAgentMessages } from "~/lib/pi-web-ui-bridge";
import type { StatusPill } from "~/lib/queries";
import { streamingStore } from "~/lib/streaming-store";
import type { ChatTimelineItem, ConnectionState, DeliveryMode, ImageAttachment } from "~/lib/types";
import { PiMessageList, type PiMessageListHandle } from "./pi-message-list";

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
  sessionId: string;
  timeline: ChatTimelineItem[];
  statusPills: StatusPill[];
  connectionState: ConnectionState;
  onSendMessage: (
    text: string,
    deliveryMode: DeliveryMode,
    images?: ImageAttachment[],
  ) => Promise<void>;
};

export function ChatPanel({
  sessionId,
  timeline,
  statusPills,
  connectionState,
  onSendMessage,
}: ChatPanelProps) {
  const isClient = useIsClient();
  const rootApi = getRouteApi("__root__");
  const { apiClient } = rootApi.useRouteContext();
  const messageListRef = useRef<PiMessageListHandle>(null);
  const { data: skillsData } = useQuery({
    queryKey: ["skills"],
    queryFn: () => apiClient.listSkills(),
    staleTime: 5 * 60 * 1000,
  });
  const [draft, setDraft] = useState("");
  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([]);
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>("followUp");
  const [isSending, setIsSending] = useState(false);

  const { viewportRef, engageAndScroll } = useStickToBottom();

  const agentMessages = useMemo(() => timelineToAgentMessages(timeline), [timeline]);

  // Wire streaming deltas from the streaming store to the Lit web component
  useEffect(() => {
    streamingStore.onStreamingDelta(sessionId, (text, messageId) => {
      if (text != null && messageId != null) {
        messageListRef.current?.updateStreaming({
          role: "assistant",
          content: [{ type: "text", text }],
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
        });
      } else {
        messageListRef.current?.clearStreaming();
      }
    });
    return () => {
      streamingStore.offStreamingDelta(sessionId);
    };
  }, [sessionId]);

  function addImageFiles(files: FileList | File[]) {
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
  }

  function removeImage(index: number) {
    setPendingImages((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    const images = pendingImages.length ? [...pendingImages] : undefined;
    if (!text && !images?.length) return;

    setIsSending(true);
    setDraft("");
    setPendingImages([]);
    engageAndScroll();

    try {
      await onSendMessage(text || "(image)", deliveryMode, images);
    } finally {
      setIsSending(false);
    }
  }

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
          {isClient && (
            <Badge variant={connectionVariant(connectionState)}>
              {connectionLabel(connectionState)}
            </Badge>
          )}
        </div>
      </div>

      {/* Message area — fills all available space */}
      <div ref={viewportRef} className="flex-1 overflow-auto px-6 py-4 space-y-3">
        <PiMessageList ref={messageListRef} messages={agentMessages} />
      </div>

      <MessageInput
        draft={draft}
        onDraftChange={setDraft}
        deliveryMode={deliveryMode}
        onDeliveryModeChange={setDeliveryMode}
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
