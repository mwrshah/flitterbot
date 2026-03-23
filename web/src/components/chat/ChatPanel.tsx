import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { type FormEvent, useMemo, useState, useSyncExternalStore } from "react";
import { Badge } from "~/components/ui/Badge";
import { MessageInput } from "~/components/ui/MessageInput";
import {
  buildStreamingAssistantMessage,
  pendingToolCallsFromTimeline,
  timelineToAgentMessages,
} from "~/lib/pi-web-ui-bridge";
import { useStickToBottom } from "~/hooks/use-stick-to-bottom";
import type { ChatTimelineItem, ConnectionState, DeliveryMode, ImageAttachment } from "~/lib/types";
import { PiMessageList } from "./PiMessageList";
import { PiStreamingMessage } from "./PiStreamingMessage";

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
  const [draft, setDraft] = useState("");
  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([]);
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>("followUp");
  const [isSending, setIsSending] = useState(false);

  const { viewportRef, isAtBottomRef, engageAndScroll } = useStickToBottom();

  const agentMessages = useMemo(() => timelineToAgentMessages(timeline), [timeline]);

  const pendingToolCalls = useMemo(() => pendingToolCallsFromTimeline(timeline), [timeline]);

  const streamingMessage = useMemo(
    () => (streamingText ? buildStreamingAssistantMessage(streamingText) : null),
    [streamingText],
  );

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
