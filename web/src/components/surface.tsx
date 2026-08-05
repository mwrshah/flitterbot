import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { CopyIcon, SettingsIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Layout as PanelLayout } from "react-resizable-panels";
import { toast } from "sonner";
import { MarkdownContent } from "~/components/common/markdown-content";
import { MessageInput } from "~/components/common/message-input";
import { HorizontalResizeHandle, Panel, PanelGroup } from "~/components/common/resizable";
import { RuntimeHealthIndicator } from "~/components/runtime-health-indicator";
import { SettingsDrawer } from "~/components/settings-drawer";
import { useCopyToClipboard } from "~/hooks/use-copy-to-clipboard";
import { parsePanelLayout, useUserConfig } from "~/hooks/use-user-config";
import { surfaceTimelineQueryOptions } from "~/lib/queries";
import type { ChatTimelineItem, ImageAttachment, StatusQueryData } from "~/lib/types";

const rootApi = getRouteApi("__root__");

const CHAT_LAYOUT_KEY = "panel:chat-layout";
const CHAT_LAYOUT_DEFAULT: Record<string, number> = { feed: 85, input: 15 };
const SCROLL_STATE_KEY = "surface:scroll-state";
const ROW_GAP = 12;
const READ_MORE_CLAMP_PX = 480;
const IMAGE_MAX_HEIGHT = 200;

type SavedScrollState = {
  offset: number;
  snapshot: VirtualItem[];
  expandedIds: string[];
};

function readSavedScrollState(): SavedScrollState | null {
  try {
    const raw = sessionStorage.getItem(SCROLL_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedScrollState>;
    if (
      typeof parsed?.offset !== "number" ||
      !Array.isArray(parsed.snapshot) ||
      !Array.isArray(parsed.expandedIds)
    ) {
      return null;
    }
    return parsed as SavedScrollState;
  } catch {
    return null;
  }
}

const LIKELY_OVERFLOWS_CHAR_THRESHOLD = 1200;

type SurfaceEntry = {
  id: string;
  timestamp: string;
  content: string;
  images?: ImageAttachment[];
  streamId?: string;
  streamName?: string;
} & ({ kind: "inbound"; source: "web" | "whatsapp" } | { kind: "streams-response" });

function timelineToEntries(timeline: ChatTimelineItem[]): SurfaceEntry[] {
  const out: SurfaceEntry[] = [];
  for (const item of timeline) {
    if (item.kind !== "message") continue;

    if (item.role === "user") {
      const source = item.source ?? "web";
      if (source !== "web" && source !== "whatsapp") continue;
      out.push({
        id: item.id,
        timestamp: item.createdAt,
        kind: "inbound",
        source,
        content: item.content,
        images: item.images,
        streamId: item.streamId,
        streamName: item.streamName,
      });
    } else if (item.role === "assistant") {
      out.push({
        id: item.id,
        timestamp: item.createdAt,
        kind: "streams-response",
        content: item.content,
        images: item.images,
        streamId: item.streamId,
        streamName: item.streamName,
      });
    }
  }
  return out;
}

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});

function formatTime(iso: string): string {
  try {
    return timeFormatter.format(new Date(iso));
  } catch {
    return "";
  }
}

function StreamBadge({ streamId, streamName }: { streamId?: string; streamName?: string }) {
  const queryClient = useQueryClient();
  if (!streamName) return null;

  let piSessionId: string | undefined;
  if (streamId) {
    const status = queryClient.getQueryData<StatusQueryData>(["status"]);
    piSessionId = status?.streams?.find((s) => s.id === streamId)?.piSessionId ?? undefined;
  }

  const cls =
    "mb-1 inline-block rounded bg-status-info-muted px-1.5 py-0.5 text-[10px] font-medium text-status-info";
  if (!piSessionId) return <span className={cls}>{streamName}</span>;

  return (
    <Link
      to="/streams/$piSessionId"
      params={{ piSessionId }}
      preload={false}
      className={`${cls} cursor-pointer transition-colors hover:bg-background-hover`}
    >
      {streamName}
    </Link>
  );
}

function ImageStack({ images }: { images: ImageAttachment[] }) {
  return (
    <div className="flex flex-col gap-2 mt-2">
      {images.map((img, i) => (
        <img
          key={i}
          src={`data:${img.mimeType};base64,${img.data}`}
          alt=""
          className="max-w-full rounded-md object-contain"
          style={{ maxHeight: `${IMAGE_MAX_HEIGHT}px` }}
        />
      ))}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const { copied, copy } = useCopyToClipboard();
  const label = copied ? "Copied" : "Copy message";

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        void copy(text).catch((error) => console.error("Failed to copy message", error));
      }}
      title={label}
      aria-label={label}
      className={`absolute bottom-1.5 right-1.5 cursor-pointer rounded p-1 transition-colors ${
        copied ? "text-status-active" : "text-text-muted hover:text-text"
      }`}
    >
      <CopyIcon className="w-3.5 h-3.5" aria-hidden="true" />
    </button>
  );
}

function EntryRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: SurfaceEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [overflowing, setOverflowing] = useState(
    () => entry.content.length > LIKELY_OVERFLOWS_CHAR_THRESHOLD,
  );

  useLayoutEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    setOverflowing(node.scrollHeight > READ_MORE_CLAMP_PX + 1);
  }, [entry.content, expanded]);

  const isInbound = entry.kind === "inbound";
  const isWhatsApp = isInbound && entry.source === "whatsapp";

  const sourceLabel = isInbound ? (isWhatsApp ? "WhatsApp" : "Web") : "Agent";

  return (
    <div className="flex gap-3 items-start">
      <div className="flex flex-col items-center gap-1 pt-0.5 shrink-0 w-16">
        <span className="text-[10px] text-text-muted">{formatTime(entry.timestamp)}</span>
        <div className="flex items-center gap-1.5">
          <span
            className={`h-2 w-2 rounded-full ${
              isInbound ? (isWhatsApp ? "bg-status-active" : "bg-status-waiting") : "bg-status-info"
            }`}
          />
          <span className="text-[10px] font-medium text-text-muted">{sourceLabel}</span>
        </div>
      </div>
      <div
        className={`group/msg relative min-w-0 flex-1 rounded-lg border px-3 py-2 ${
          isInbound
            ? "border-border-pop bg-background-pop"
            : "border-border-muted bg-background-muted"
        }`}
      >
        <StreamBadge streamId={entry.streamId} streamName={entry.streamName} />
        <div className="relative">
          <div
            ref={contentRef}
            style={
              !expanded ? { maxHeight: `${READ_MORE_CLAMP_PX}px`, overflow: "hidden" } : undefined
            }
          >
            <MarkdownContent content={entry.content} />
          </div>
          {(overflowing || expanded) && (
            <button
              type="button"
              onClick={onToggle}
              className="mt-1 text-xs text-text-muted hover:text-text transition-colors cursor-pointer"
            >
              {expanded ? "Show less" : "Read more"}
            </button>
          )}
        </div>
        {entry.images && entry.images.length > 0 && <ImageStack images={entry.images} />}
        <CopyButton text={entry.content} />
      </div>
    </div>
  );
}

export function Surface() {
  const { sendMessage } = rootApi.useRouteContext();
  const { config, setConfig } = useUserConfig();
  const chatLayout = parsePanelLayout(config, CHAT_LAYOUT_KEY, CHAT_LAYOUT_DEFAULT);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([]);
  const [isSending, setIsSending] = useState(false);

  const { data: timeline = [] } = useQuery(surfaceTimelineQueryOptions());
  const entries = useMemo(() => timelineToEntries(timeline), [timeline]);

  const scrollRef = useRef<HTMLDivElement>(null);

  const savedRef = useRef<SavedScrollState | null | undefined>(undefined);
  if (savedRef.current === undefined) savedRef.current = readSavedScrollState();

  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(savedRef.current?.expandedIds ?? []),
  );
  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const lastEntryId = entries[entries.length - 1]?.id;
  const isLastExpanded = lastEntryId !== undefined && expandedIds.has(lastEntryId);

  const expandedIdsRef = useRef(expandedIds);
  useEffect(() => {
    expandedIdsRef.current = expandedIds;
  });

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 120,
    overscan: 6,
    gap: ROW_GAP,
    getItemKey: (index) => entries[index]?.id ?? index,
    anchorTo: isLastExpanded ? "start" : "end",
    followOnAppend: !isLastExpanded,
    scrollEndThreshold: 32,
    initialMeasurementsCache: savedRef.current?.snapshot ?? [],
    initialOffset: savedRef.current?.offset,
  });

  useLayoutEffect(() => {
    if (savedRef.current) return;
    virtualizer.scrollToEnd();
  }, [virtualizer]);

  useEffect(() => {
    return () => {
      const snapshot = virtualizer.takeSnapshot();
      if (snapshot.length === 0) return;
      sessionStorage.setItem(
        SCROLL_STATE_KEY,
        JSON.stringify({
          offset: virtualizer.scrollOffset ?? 0,
          snapshot,
          expandedIds: Array.from(expandedIdsRef.current),
        }),
      );
    };
  }, [virtualizer]);

  const items = virtualizer.getVirtualItems();

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

  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const pendingImagesRef = useRef(pendingImages);
  useEffect(() => {
    pendingImagesRef.current = pendingImages;
  });

  const handleSubmit = useCallback(
    async (text: string) => {
      const images = pendingImagesRef.current.length ? [...pendingImagesRef.current] : undefined;
      if (!text && !images?.length) return;

      virtualizer.scrollToEnd();

      setIsSending(true);
      try {
        await sendMessage(text || "(image)", { images });
        setPendingImages([]);
      } catch (error) {
        toast.error("Failed to send message");
        console.error("handleSubmit send failed:", error);
      } finally {
        setIsSending(false);
      }
    },
    [sendMessage, virtualizer],
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-1.5 border-b border-border shrink-0">
        <div>
          <h1 className="text-sm font-semibold text-text">Surface</h1>
          <p className="text-[10px] text-text-muted">Highlights from all streams</p>
        </div>
        <div className="flex items-center gap-2">
          <RuntimeHealthIndicator />
          <button
            type="button"
            onClick={openSettings}
            className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-background-hover hover:text-text"
            title="Settings"
          >
            <SettingsIcon className="size-4" />
          </button>
        </div>
      </div>

      <SettingsDrawer open={settingsOpen} onClose={closeSettings} />

      <PanelGroup
        orientation="vertical"
        className="flex-1 min-h-0"
        defaultLayout={chatLayout}
        onLayoutChanged={(layout: PanelLayout) =>
          setConfig(CHAT_LAYOUT_KEY, JSON.stringify(layout))
        }
      >
        <Panel id="feed" defaultSize="85%" minSize="20%">
          <div
            ref={scrollRef}
            data-scroll-container="main"
            className="h-full overflow-auto px-6 py-4"
            style={{ contain: "strict", overflowAnchor: "none" }}
          >
            {entries.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <p className="text-sm text-text-muted">No activity yet</p>
              </div>
            ) : (
              <div
                style={{
                  height: `${virtualizer.getTotalSize()}px`,
                  position: "relative",
                  width: "100%",
                }}
              >
                {items.map((virtualItem) => {
                  const entry = entries[virtualItem.index];
                  if (!entry) return null;
                  return (
                    <div
                      key={virtualItem.key}
                      data-index={virtualItem.index}
                      ref={virtualizer.measureElement}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${virtualItem.start}px)`,
                      }}
                    >
                      <EntryRow
                        entry={entry}
                        expanded={expandedIds.has(entry.id)}
                        onToggle={() => toggleExpanded(entry.id)}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Panel>

        <HorizontalResizeHandle />

        <Panel id="input" defaultSize="15%" minSize="9%" style={{ overflow: "visible" }}>
          <MessageInput
            draftKey="__surface__"
            isSending={isSending}
            onSubmit={handleSubmit}
            pendingImages={pendingImages}
            onAddImages={addImageFiles}
            onRemoveImage={removeImage}
            fillHeight
            showModelSelector={false}
            internalCommandScope="surface"
          />
        </Panel>
      </PanelGroup>
    </div>
  );
}
