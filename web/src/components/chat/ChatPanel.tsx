import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useControlSurface } from "~/hooks/use-control-surface";
import {
  timelineToAgentMessages,
  buildStreamingAssistantMessage,
  pendingToolCallsFromTimeline,
} from "~/lib/pi-web-ui-bridge";
import type {
  ChatTimelineItem,
  ChatTimelineTool,
  ConnectionState,
  DeliveryMode,
  ImageAttachment,
} from "~/lib/types";
import type { MessageSource } from "~/lib/types";
import { createId, extractToolName } from "~/lib/utils";
import { Badge } from "~/components/ui/Badge";
import { MessageInput } from "~/components/ui/MessageInput";
import { PiMessageList } from "./PiMessageList";
import { PiStreamingMessage } from "./PiStreamingMessage";

const initialTimeline: ChatTimelineItem[] = [];

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

function connectionVariant(
  state: ConnectionState,
): "success" | "warning" | "muted" | "default" {
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

type StatusPill = { id: string; label: string; variant?: "info" | "error" };

export function ChatPanel({ piSessionId }: { piSessionId?: string } = {}) {
  const { apiClient, wsClient } = useControlSurface();
  const [draft, setDraft] = useState("");
  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([]);

  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>("followUp");
  const [timeline, setTimeline] = useState<ChatTimelineItem[]>(initialTimeline);
  const [connectionState, setConnectionState] = useState<ConnectionState>(
    wsClient.connectionState,
  );
  const [isSending, setIsSending] = useState(false);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [statusPills, setStatusPills] = useState<StatusPill[]>([]);
  const activeAssistantId = useRef<string | null>(null);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const isAtBottomRef = useRef(true);

  const addPill = (pill: StatusPill) =>
    setStatusPills((prev) => {
      const next = [...prev.filter((p) => p.id !== pill.id), pill];
      return next.slice(-6);
    });

  const removePill = (id: string) =>
    setStatusPills((prev) => prev.filter((p) => p.id !== id));

  const agentMessages = useMemo(
    () => timelineToAgentMessages(timeline),
    [timeline],
  );

  const pendingToolCalls = useMemo(
    () => pendingToolCallsFromTimeline(timeline),
    [timeline],
  );

  const streamingMessage = useMemo(
    () => (streamingText ? buildStreamingAssistantMessage(streamingText) : null),
    [streamingText],
  );

  // Scroll viewport to bottom (used on mount and after history hydration)
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = viewportRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  // Hydrate from history on mount, then scroll to bottom
  useEffect(() => {
    let cancelled = false;
    void apiClient
      .getPiHistory(undefined, piSessionId)
      .then((history) => {
        if (cancelled) return;
        setTimeline((current) => [...history.items, ...current]);
        scrollToBottom();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [apiClient, piSessionId, scrollToBottom]);

  // WebSocket events
  useEffect(() => {
    const unsubscribe = wsClient.subscribe((message) => {
      // Filter events by sessionId when viewing a specific Pi session
      if (
        piSessionId &&
        "sessionId" in message &&
        message.sessionId &&
        message.sessionId !== piSessionId
      ) {
        return;
      }

      if (message.type === "connected") {
        addPill({
          id: "ws-connected",
          label: `WS ${message.clientId.slice(0, 8)}`,
        });
        return;
      }

      if (message.type === "message_queued") {
        addPill({
          id: `queued-${message.itemId}`,
          label: `Queued (${message.queueDepth})`,
        });
        return;
      }

      if (message.type === "queue_item_start") {
        const sourceLabel =
          message.item.source === "whatsapp" ? "WhatsApp" :
          message.item.source === "hook" ? "Hook" :
          message.item.source === "cron" ? "Cron" : "Web";
        addPill({
          id: `processing-${message.item.id}`,
          label: `Processing ${sourceLabel} message`,
          variant: message.item.source !== "web" ? "info" : undefined,
        });
        return;
      }

      if (message.type === "queue_item_end") {
        removePill(`processing-${message.itemId}`);
        removePill(`queued-${message.itemId}`);
        if (message.error) {
          addPill({
            id: `error-${message.itemId}`,
            label: message.error,
            variant: "error",
          });
        }
        return;
      }

      if (message.type === "text_delta") {
        setStreamingText((prev) => (prev ?? "") + message.delta);
        return;
      }

      if (message.type === "message_end") {
        const content = message.content || "";

        if (message.role === "user") {
          if (content.trim()) {
            setTimeline((current) => [
              ...current,
              {
                id: createId("user"),
                kind: "message",
                role: "user",
                content,
                source: (message.source as MessageSource) ?? "web",
                createdAt: message.timestamp ?? new Date().toISOString(),
              },
            ]);
          }
          return;
        }

        setStreamingText(null);
        activeAssistantId.current = null;
        if (content.trim()) {
          setTimeline((current) => [
            ...current,
            {
              id: createId("assistant"),
              kind: "message",
              role: "assistant",
              content,
              createdAt: message.timestamp ?? new Date().toISOString(),
            },
          ]);
        }
        return;
      }

      if (
        message.type === "tool_execution_start" ||
        message.type === "tool_execution_end"
      ) {
        const eventRecord =
          message.event && typeof message.event === "object"
            ? (message.event as Record<string, unknown>)
            : undefined;

        const toolEvent: ChatTimelineTool = {
          id: createId("tool"),
          kind: "tool",
          tool: message.tool || extractToolName(message.event),
          phase: message.type === "tool_execution_start" ? "start" : "end",
          toolUseId: message.toolUseId,
          args:
            message.type === "tool_execution_start"
              ? (message.args ??
                eventRecord?.arguments ??
                eventRecord?.args ??
                eventRecord?.toolArguments)
              : undefined,
          result:
            message.type === "tool_execution_end"
              ? (message.result ??
                eventRecord?.result ??
                eventRecord?.output ??
                eventRecord?.toolResult)
              : undefined,
          isError:
            message.type === "tool_execution_end"
              ? message.isError
              : undefined,
          createdAt: message.timestamp ?? new Date().toISOString(),
        };
        setTimeline((current) => [...current, toolEvent]);
        return;
      }

      if (message.type === "turn_end") {
        setStreamingText(null);
        activeAssistantId.current = null;
        setTimeline((current) => [
          ...current,
          {
            id: createId("divider-turn-end"),
            kind: "divider",
            createdAt: new Date().toISOString(),
          },
        ]);
        return;
      }

      if (message.type === "error") {
        addPill({
          id: createId("error"),
          label: message.message,
          variant: "error",
        });
      }
    });

    const unsubscribeConnection = wsClient.subscribeConnection(
      setConnectionState,
    );
    return () => {
      unsubscribe();
      unsubscribeConnection();
    };
  }, [wsClient, piSessionId]);

  // Track whether the user is at the bottom of the scroll container
  const handleScroll = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const threshold = 50;
    isAtBottomRef.current =
      el.scrollTop + el.clientHeight >= el.scrollHeight - threshold;
  }, []);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  // Auto-scroll only when user is already at the bottom
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !isAtBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [agentMessages, streamingText, timeline]);

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
    isAtBottomRef.current = true;

    // No optimistic update — wait for the server's decorated message via WebSocket.

    try {
      await wsClient.sendMessage(text || "(image)", deliveryMode, images, piSessionId);
    } catch {
      const response = await apiClient.queueMessage({
        text: text || "(image)",
        source: "web",
        deliveryMode,
        images,
        targetSessionId: piSessionId,
      });
      addPill({
        id: createId("http-queued"),
        label: `Queued via HTTP (${response.queueDepth})`,
      });
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
                <Badge
                  key={pill.id}
                  variant={pill.variant === "error" ? "error" : "muted"}
                >
                  {pill.label}
                </Badge>
              ))}
            </div>
          )}
          <Badge variant={connectionVariant(connectionState)}>
            {connectionLabel(connectionState)}
          </Badge>
        </div>
      </div>

      {/* Message area — fills all available space */}
      <div
        ref={viewportRef}
        className="flex-1 overflow-auto px-6 py-4 space-y-3"
      >
        <PiMessageList
          messages={agentMessages}
          isStreaming={streamingText !== null}
          pendingToolCalls={pendingToolCalls}
        />
        <PiStreamingMessage
          message={streamingMessage}
          visible={streamingText !== null}
        />
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
        rows={2}
      />
    </div>
  );
}
