import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { type FormEvent, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Badge } from "~/components/ui/badge";
import { MessageInput } from "~/components/ui/message-input";
import { useStickToBottom } from "~/hooks/use-stick-to-bottom";
import { ensurePiWebUiReady } from "~/lib/pi-web-ui-init";
import { connectionStateQueryOptions, inputSurfaceTimelineQueryOptions } from "~/lib/queries";
import type {
  ChatTimelineItem,
  ChatTimelineMessage,
  ConnectionState,
  DeliveryMode,
  ImageAttachment,
  MessageSource,
} from "~/lib/types";
import { mergeTimelines } from "~/lib/utils";

/* ── Types ── */

type SurfaceEntry = {
  id: string;
  timestamp: string;
} & (
  | { kind: "inbound"; source: MessageSource; content: string; workstreamName?: string }
  | { kind: "outbound"; channel: "whatsapp" | "all"; content: string }
  | { kind: "hook"; eventName: string; detail: string }
  | { kind: "pi-response"; content: string; workstreamName?: string }
);

/* ── Helpers ── */

const SOURCE_COLORS: Record<MessageSource, string> = {
  whatsapp: "bg-emerald-500",
  web: "bg-orange-400",
  hook: "bg-violet-500",
  cron: "bg-cyan-500",
  init: "bg-gray-400",
  agent: "bg-blue-500",
  pi_outbound: "bg-amber-500",
};

const SOURCE_LABELS: Record<MessageSource, string> = {
  whatsapp: "WhatsApp",
  web: "Web",
  hook: "Hook",
  cron: "Cron",
  init: "Init",
  agent: "Agent",
  pi_outbound: "Pi",
};

const WORKSTREAM_PREFIX_RE = /^\[Workstream: "([^"]+)" \([0-9a-f-]+\)\]\s*(?:\[NEW\]\s*)?/;

function parseWorkstreamPrefix(
  content: string,
): { workstreamName: string; cleanContent: string } | null {
  const match = content.match(WORKSTREAM_PREFIX_RE);
  if (!match) return null;
  return { workstreamName: match[1] ?? "", cleanContent: content.slice(match[0]!.length) };
}

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
      const source = msg.source ?? "web";
      if (source !== "web" && source !== "whatsapp") continue;
      entries.push({
        id: item.id,
        timestamp: item.createdAt,
        kind: "inbound",
        source: msg.source ?? "web",
        content: msg.content,
        workstreamName: item.workstreamName,
      });
      continue;
    }

    if (item.kind === "message" && item.role === "assistant") {
      entries.push({
        id: item.id,
        timestamp: item.createdAt,
        kind: "pi-response",
        content: item.content,
        workstreamName: item.workstreamName,
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

/* ── Collapsible Content Wrapper ── */

const MAX_LINES = 30;

function CollapsibleContent({
  children,
  fadeClassName = "from-card",
}: {
  children: React.ReactNode;
  fadeClassName?: string;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    setIsOverflowing(el.scrollHeight > el.clientHeight + 1);
  });

  return (
    <div className="relative">
      <div
        ref={contentRef}
        style={!expanded ? { maxHeight: `calc(${MAX_LINES}lh)`, overflow: "hidden" } : undefined}
      >
        {children}
      </div>
      {isOverflowing && !expanded && (
        <div
          className={`absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t ${fadeClassName} to-transparent pointer-events-none`}
        />
      )}
      {(isOverflowing || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          {expanded ? "Show less" : "Read more"}
        </button>
      )}
    </div>
  );
}

/* ── Entry Renderers ── */

function InboundEntry({ entry }: { entry: SurfaceEntry & { kind: "inbound" } }) {
  const parsed = useMemo(() => parseWorkstreamPrefix(entry.content), [entry.content]);
  const displayContent = parsed ? parsed.cleanContent : entry.content;
  const badgeName = parsed?.workstreamName ?? entry.workstreamName;

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
        {badgeName && (
          <span className="inline-block text-[10px] font-medium text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900/40 rounded px-1.5 py-0.5 mb-1">
            {badgeName}
          </span>
        )}
        <CollapsibleContent>
          <p className="text-sm text-foreground whitespace-pre-wrap break-words">
            {displayContent}
          </p>
        </CollapsibleContent>
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
          <span
            className={`w-2 h-2 rounded-full ${isWhatsApp ? "bg-emerald-500" : "bg-blue-500"}`}
          />
          <span className="text-[10px] font-medium text-muted-foreground">
            {isWhatsApp ? "WA Out" : "Notify"}
          </span>
        </div>
      </div>
      <div
        className={`flex-1 min-w-0 rounded-lg border px-3 py-2 ${
          isWhatsApp ? "border-emerald-500/25 bg-emerald-500/5" : "border-blue-500/25 bg-blue-500/5"
        }`}
      >
        <p className="text-sm text-foreground whitespace-pre-wrap break-words">{entry.content}</p>
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
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch((err) => console.error("pi-web-ui init failed:", err));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ready || !containerRef.current) return;
    if (!elementRef.current) {
      const el = document.createElement("markdown-block");
      containerRef.current.appendChild(el);
      elementRef.current = el;
    }
    (elementRef.current as HTMLElement & { content: string }).content = content;
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
        {entry.workstreamName && (
          <span className="inline-block text-[10px] font-medium text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900/40 rounded px-1.5 py-0.5 mb-1">
            {entry.workstreamName}
          </span>
        )}
        <CollapsibleContent fadeClassName="from-muted/30">
          <LitMarkdownBlock content={entry.content} />
        </CollapsibleContent>
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
          <p className="text-sm text-foreground whitespace-pre-wrap break-words">{entry.detail}</p>
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

const rootApi = getRouteApi("__root__");

const emptySubscribe = () => () => {};
const useIsClient = () =>
  useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );

export function InputSurface({ loaderTimeline = [] }: { loaderTimeline?: ChatTimelineItem[] }) {
  const isClient = useIsClient();
  const { apiClient, sendMessage } = rootApi.useRouteContext();
  const [draft, setDraft] = useState("");
  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([]);
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>("followUp");
  const { data: rawConnectionState = "disconnected" as ConnectionState } = useQuery(
    connectionStateQueryOptions(),
  );
  const connectionState = isClient ? rawConnectionState : ("disconnected" as ConnectionState);
  const [isSending, setIsSending] = useState(false);
  const { data: skillsData } = useQuery({
    queryKey: ["skills"],
    queryFn: () => apiClient.listSkills(),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  // WS-appended items from Query cache (written by ws-query-bridge)
  const { data: wsAppendedItems = [] } = useQuery(inputSurfaceTimelineQueryOptions());

  const { viewportRef, engageAndScroll } = useStickToBottom();

  const timeline = useMemo(
    () => mergeTimelines(loaderTimeline, wsAppendedItems),
    [loaderTimeline, wsAppendedItems],
  );
  const entries = useMemo(() => timelineToSurfaceEntries(timeline), [timeline]);

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
      await sendMessage(text || "(image)", deliveryMode, images);
    } finally {
      setIsSending(false);
    }
  }

  const connectionLabel =
    connectionState === "connected"
      ? "Live"
      : connectionState === "connecting" || connectionState === "reconnecting"
        ? "Connecting"
        : "Offline";
  const connectionVariant =
    connectionState === "connected"
      ? ("success" as const)
      : connectionState === "connecting" || connectionState === "reconnecting"
        ? ("warning" as const)
        : ("muted" as const);

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
      <div ref={viewportRef} className="flex-1 overflow-auto px-6 py-4 space-y-3">
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
