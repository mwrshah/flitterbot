import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useControlSurface } from "~/hooks/use-control-surface";
import type {
  ChatTimelineItem,
  ChatTimelineMessage,
  ConnectionState,
  DeliveryMode,
  ImageAttachment,
  MessageSource,
} from "~/lib/types";
import { createId } from "~/lib/utils";
import { Badge } from "~/components/ui/Badge";
import { MessageInput } from "~/components/ui/MessageInput";
import { ensurePiWebUiReady } from "~/lib/pi-web-ui-init";

/* ── Types ── */

type SurfaceEntry = {
  id: string;
  timestamp: string;
} & (
  | { kind: "inbound"; source: MessageSource; content: string }
  | { kind: "outbound"; channel: "whatsapp" | "all"; content: string }
  | { kind: "hook"; eventName: string; detail: string }
  | { kind: "pi-response"; content: string }
);

/* ── Helpers ── */

const SOURCE_COLORS: Record<MessageSource, string> = {
  whatsapp: "bg-emerald-500",
  web: "bg-orange-400",
  hook: "bg-violet-500",
  cron: "bg-cyan-500",
  init: "bg-gray-400",
};

const SOURCE_LABELS: Record<MessageSource, string> = {
  whatsapp: "WhatsApp",
  web: "Web",
  hook: "Hook",
  cron: "Cron",
  init: "Init",
};

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function timelineToSurfaceEntries(timeline: ChatTimelineItem[]): SurfaceEntry[] {
  const entries: SurfaceEntry[] = [];

  for (const item of timeline) {
    if (item.kind === "divider") continue;

    if (item.kind === "message" && item.role === "user") {
      const msg = item as ChatTimelineMessage;
      entries.push({
        id: item.id,
        timestamp: item.createdAt,
        kind: "inbound",
        source: msg.source ?? "web",
        content: msg.content,
      });
      continue;
    }

    if (item.kind === "message" && item.role === "assistant") {
      entries.push({
        id: item.id,
        timestamp: item.createdAt,
        kind: "pi-response",
        content: item.content,
      });
      continue;
    }

    if (item.kind === "tool") {
      // Skip all tool calls — only user messages and pi responses shown
      // (mirrors WhatsApp: user message in, pi final text response out)
    }
  }

  return entries;
}

/* ── Entry Renderers ── */

function InboundEntry({ entry }: { entry: SurfaceEntry & { kind: "inbound" } }) {
  return (
    <div className="flex gap-3 items-start">
      <div className="flex flex-col items-center gap-1 pt-0.5 shrink-0 w-16">
        <span className="text-[10px] text-muted-foreground/60">{formatTime(entry.timestamp)}</span>
        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${SOURCE_COLORS[entry.source]}`} />
          <span className="text-[10px] font-medium text-muted-foreground">
            {SOURCE_LABELS[entry.source]}
          </span>
        </div>
      </div>
      <div className="flex-1 min-w-0 rounded-lg border border-border bg-card px-3 py-2">
        <p className="text-sm text-foreground whitespace-pre-wrap break-words">
          {entry.content}
        </p>
      </div>
    </div>
  );
}

function OutboundEntry({ entry }: { entry: SurfaceEntry & { kind: "outbound" } }) {
  const isWhatsApp = entry.channel === "whatsapp";
  return (
    <div className="flex gap-3 items-start">
      <div className="flex flex-col items-center gap-1 pt-0.5 shrink-0 w-16">
        <span className="text-[10px] text-muted-foreground/60">{formatTime(entry.timestamp)}</span>
        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${isWhatsApp ? "bg-emerald-500" : "bg-blue-500"}`} />
          <span className="text-[10px] font-medium text-muted-foreground">
            {isWhatsApp ? "WA Out" : "Notify"}
          </span>
        </div>
      </div>
      <div
        className={`flex-1 min-w-0 rounded-lg border px-3 py-2 ${
          isWhatsApp
            ? "border-emerald-500/25 bg-emerald-500/5"
            : "border-blue-500/25 bg-blue-500/5"
        }`}
      >
        <p className="text-sm text-foreground whitespace-pre-wrap break-words">
          {entry.content}
        </p>
      </div>
    </div>
  );
}

function LitMarkdownBlock({ content }: { content: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const elementRef = useRef<HTMLElement | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    ensurePiWebUiReady()
      .then(() => { if (!cancelled) setReady(true); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!ready || !containerRef.current) return;
    if (!elementRef.current) {
      const el = document.createElement("markdown-block");
      containerRef.current.appendChild(el);
      elementRef.current = el;
    }
    (elementRef.current as any).content = content;
  }, [ready, content]);

  return <div ref={containerRef} />;
}

function PiResponseEntry({ entry }: { entry: SurfaceEntry & { kind: "pi-response" } }) {
  return (
    <div className="flex gap-3 items-start">
      <div className="flex flex-col items-center gap-1 pt-0.5 shrink-0 w-16">
        <span className="text-[10px] text-muted-foreground/60">{formatTime(entry.timestamp)}</span>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-blue-400" />
          <span className="text-[10px] font-medium text-muted-foreground">Pi</span>
        </div>
      </div>
      <div className="flex-1 min-w-0 rounded-lg border border-border bg-muted/30 px-3 py-2">
        <LitMarkdownBlock content={entry.content} />
      </div>
    </div>
  );
}

function HookEntry({ entry }: { entry: SurfaceEntry & { kind: "hook" } }) {
  return (
    <div className="flex gap-3 items-start">
      <div className="flex flex-col items-center gap-1 pt-0.5 shrink-0 w-16">
        <span className="text-[10px] text-muted-foreground/60">{formatTime(entry.timestamp)}</span>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-violet-500" />
          <span className="text-[10px] font-medium text-muted-foreground">Hook</span>
        </div>
      </div>
      <div className="flex-1 min-w-0 rounded-lg border border-violet-500/25 bg-violet-500/5 px-3 py-2">
        <p className="text-xs font-medium text-muted-foreground mb-1">{entry.eventName}</p>
        {entry.detail && (
          <p className="text-sm text-foreground whitespace-pre-wrap break-words">
            {entry.detail}
          </p>
        )}
      </div>
    </div>
  );
}

function SurfaceEntryRenderer({ entry }: { entry: SurfaceEntry }) {
  switch (entry.kind) {
    case "inbound":
      return <InboundEntry entry={entry} />;
    case "outbound":
      return <OutboundEntry entry={entry} />;
    case "pi-response":
      return <PiResponseEntry entry={entry} />;
    case "hook":
      return <HookEntry entry={entry} />;
  }
}

/* ── Main Component ── */

export function InputSurface() {
  const { apiClient, wsClient } = useControlSurface();
  const [draft, setDraft] = useState("");
  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([]);
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>("followUp");
  const [timeline, setTimeline] = useState<ChatTimelineItem[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>(
    wsClient.connectionState,
  );
  const [isSending, setIsSending] = useState(false);
  const { data: skillsData } = useQuery({
    queryKey: ["skills"],
    queryFn: () => apiClient.listSkills(),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const isAtBottomRef = useRef(true);

  const entries = useMemo(() => timelineToSurfaceEntries(timeline), [timeline]);

  // Scroll viewport to bottom (used on mount and after history hydration)
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = viewportRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  // Hydrate from history, then scroll to bottom
  useEffect(() => {
    let cancelled = false;
    void apiClient
      .getPiHistory("input")
      .then((history) => {
        if (cancelled) return;
        setTimeline((current) => [...history.items, ...current]);
        scrollToBottom();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [apiClient, scrollToBottom]);

  // WebSocket events — same as ChatPanel but we store into timeline
  useEffect(() => {
    const unsubscribe = wsClient.subscribe((message) => {
      if (message.type === "text_delta") {
        // Intentionally ignored — Input Surface only shows final pi_surfaced messages,
        // not intermediate streaming text (which may include reasoning, tool calls, etc.)
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

        // Don't add assistant message_end to timeline — only pi_surfaced events appear
        return;
      }

      if (message.type === "pi_surfaced") {
        if (message.content.trim()) {
          setTimeline((current) => [
            ...current,
            {
              id: createId("assistant"),
              kind: "message",
              role: "assistant",
              content: message.content,
              createdAt: message.timestamp ?? new Date().toISOString(),
            },
          ]);
        }
        return;
      }
    });

    wsClient.subscribeSession("*");

    const unsubscribeConnection = wsClient.subscribeConnection(
      setConnectionState,
    );
    return () => {
      unsubscribe();
      unsubscribeConnection();
      wsClient.unsubscribeSession("*");
    };
  }, [wsClient]);

  // Scroll tracking
  const handleScroll = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    isAtBottomRef.current =
      el.scrollTop + el.clientHeight >= el.scrollHeight - 50;
  }, []);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !isAtBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [entries]);

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

    try {
      await wsClient.sendMessage(text || "(image)", deliveryMode, images);
    } catch {
      await apiClient.queueMessage({
        text: text || "(image)",
        source: "web",
        deliveryMode,
        images,
      });
    } finally {
      setIsSending(false);
    }
  }

  const connectionLabel =
    connectionState === "connected" ? "Live" :
    connectionState === "connecting" || connectionState === "reconnecting" ? "Connecting" :
    "Offline";
  const connectionVariant =
    connectionState === "connected" ? "success" as const :
    connectionState === "connecting" || connectionState === "reconnecting" ? "warning" as const :
    "muted" as const;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border shrink-0">
        <div>
          <h1 className="text-sm font-semibold text-foreground">Input Surface</h1>
          <p className="text-[10px] text-muted-foreground/60">All channels flowing through Pi</p>
        </div>
        <Badge variant={connectionVariant}>{connectionLabel}</Badge>
      </div>

      {/* Activity feed */}
      <div
        ref={viewportRef}
        className="flex-1 overflow-auto px-6 py-4 space-y-3"
      >
        {entries.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-muted-foreground/50">No activity yet</p>
          </div>
        )}
        {entries.map((entry) => (
          <SurfaceEntryRenderer key={entry.id} entry={entry} />
        ))}
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
        placeholder="Message Pi via Web…"
      />
    </div>
  );
}
