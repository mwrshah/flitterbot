import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { CopyIcon, SettingsIcon } from "lucide-react";
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { MarkdownContent } from "~/components/common/markdown-content";
import { MessageInput } from "~/components/common/message-input";
import { HorizontalResizeHandle, Panel, PanelGroup } from "~/components/common/resizable";
import { RuntimeHealthIndicator } from "~/components/runtime-health-indicator";
import { SettingsDrawer } from "~/components/settings-drawer";
import { parsePanelLayout, useUserConfig } from "~/hooks/use-user-config";
import { surfaceTimelineQueryOptions } from "~/lib/queries";
import type { ChatTimelineItem, ImageAttachment, StatusResponse } from "~/lib/types";

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

// Char-length heuristic for whether a row's content will probably overflow the
// clamp on first render. Used to seed EntryRow's `overflowing` state so the
// Read-more button is present in the very first DOM commit — which keeps the
// row's measured height stable across the useLayoutEffect that does the DOM-
// truth check. False positives self-correct via that effect; the goal is just
// to make the steady state the starting state for the common case (long agent
// responses), so virtual-core's snapshot-restore sizes match reality.
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

/* ── Subcomponents ── */

function StreamBadge({ streamId, streamName }: { streamId?: string; streamName?: string }) {
  const queryClient = useQueryClient();
  if (!streamName) return null;

  let piSessionId: string | undefined;
  if (streamId) {
    const status = queryClient.getQueryData<StatusResponse>(["status"]);
    piSessionId = status?.streams?.find((s) => s.id === streamId)?.piSessionId ?? undefined;
  }

  const cls =
    "inline-block text-[10px] font-medium text-orange-800 bg-orange-700/10 dark:text-orange-300 rounded px-1.5 py-0.5 mb-1";
  if (!piSessionId) return <span className={cls}>{streamName}</span>;

  return (
    <Link
      to="/streams/$piSessionId"
      params={{ piSessionId }}
      className={`${cls} cursor-pointer hover:bg-orange-700/20 transition-colors`}
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
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <button
      type="button"
      onClick={onClick}
      title={copied ? "Copied" : "Copy message"}
      className={`absolute bottom-1.5 right-1.5 p-1 rounded transition-opacity cursor-pointer ${
        copied
          ? "text-emerald-500 opacity-100"
          : "text-muted-foreground/40 hover:text-muted-foreground opacity-60 hover:opacity-100"
      }`}
    >
      <CopyIcon className="w-3.5 h-3.5" />
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

  // DOM-truth overflow check: scrollHeight reflects the real rendered content.
  useLayoutEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    setOverflowing(node.scrollHeight > READ_MORE_CLAMP_PX + 1);
  }, [entry.content, expanded]);

  const isInbound = entry.kind === "inbound";
  const isWhatsApp = isInbound && entry.source === "whatsapp";

  const dotClass = isInbound ? (isWhatsApp ? "bg-emerald-500" : "bg-orange-400") : "bg-blue-400";
  const sourceLabel = isInbound ? (isWhatsApp ? "WhatsApp" : "Web") : "Agent";
  const bubbleClass = isInbound ? "bg-card" : "bg-muted/30";
  const fadeFrom = isInbound ? "from-card" : "from-muted/30";

  return (
    <div className="flex gap-3 items-start">
      <div className="flex flex-col items-center gap-1 pt-0.5 shrink-0 w-16">
        <span className="text-[10px] text-muted-foreground/60">{formatTime(entry.timestamp)}</span>
        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${dotClass}`} />
          <span className="text-[10px] font-medium text-muted-foreground">{sourceLabel}</span>
        </div>
      </div>
      <div
        className={`group/msg relative flex-1 min-w-0 rounded-lg border border-border ${bubbleClass} px-3 py-2`}
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
          {overflowing && !expanded && (
            <div
              className={`absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t ${fadeFrom} to-transparent pointer-events-none`}
            />
          )}
          {(overflowing || expanded) && (
            <button
              type="button"
              onClick={onToggle}
              className="mt-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
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

/* ── Main Component ── */

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

  // Read sessionStorage once before useVirtualizer reads initial* options.
  // Lazy ref so the read happens exactly once per mount.
  const savedRef = useRef<SavedScrollState | null | undefined>(undefined);
  if (savedRef.current === undefined) savedRef.current = readSavedScrollState();

  // Expanded state lives here (not inside EntryRow) so we can derive
  // "is the last entry expanded" and feed it into the virtualizer options.
  // Seeded from sessionStorage so navigating away and back preserves which
  // rows the user had expanded.
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

  // Mirror expandedIds into a ref so the unmount-time persistence effect can
  // read the latest value without taking expandedIds as a dependency (which
  // would re-fire the cleanup on every toggle).
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
    // anchorTo='end' + followOnAppend pin the viewport to the bottom when the
    // last message grows during streaming AND when new entries arrive while
    // the user is within scrollEndThreshold of the bottom. Both flip off when
    // the user has Read-more'd the last entry — otherwise clicking it would
    // yank the viewport down to the bottom of the now-tall row. When a newer
    // message arrives, isLastExpanded becomes false again (the expanded entry
    // is no longer the last) and end-anchoring resumes for the new tail.
    anchorTo: isLastExpanded ? "start" : "end",
    followOnAppend: !isLastExpanded,
    scrollEndThreshold: 32,
    // Seed from the persisted snapshot. Items in the cache keep their measured
    // sizes; missing items (entries appended while we were away) fall back to
    // estimateSize and get re-measured on scroll. The cache is consumed once.
    initialMeasurementsCache: savedRef.current?.snapshot ?? [],
    initialOffset: savedRef.current?.offset,
  });

  // Fresh-mount landing: scroll to bottom only when we had no saved position.
  // When restored, initialOffset already put us where we left off — jumping to
  // the end would defeat the point. anchorTo='end' + followOnAppend handle
  // live updates either way.
  useLayoutEffect(() => {
    if (savedRef.current) return;
    virtualizer.scrollToEnd();
  }, [virtualizer]);

  // Persist on unmount. Skip if nothing was measured — an empty snapshot would
  // overwrite a real saved state with garbage on a fast nav-away.
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

  /* ── Input handlers ── */

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

  // Snapshot pending images at submit time — MessageInput memoizes its onSubmit
  // closure, so reading from state directly would see the initial empty array.
  const pendingImagesRef = useRef(pendingImages);
  useEffect(() => {
    pendingImagesRef.current = pendingImages;
  });

  const handleSubmit = useCallback(
    async (text: string) => {
      const images = pendingImagesRef.current.length ? [...pendingImagesRef.current] : undefined;
      if (!text && !images?.length) return;

      // Jump to the bottom on submit so the user sees their own message land
      // and the response stream in. Independent of anchorTo — even if they
      // were scrolled up reading history, sending is an explicit intent to
      // re-engage with the live tail.
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
          <h1 className="text-sm font-semibold text-foreground">Surface</h1>
          <p className="text-[10px] text-muted-foreground/60">Highlights from all streams</p>
        </div>
        <div className="flex items-center gap-2">
          <RuntimeHealthIndicator />
          <button
            type="button"
            onClick={openSettings}
            className="p-1.5 rounded-md text-muted-foreground/50 hover:text-muted-foreground hover:bg-accent/50 transition-colors"
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
        onLayoutChanged={(layout) => setConfig(CHAT_LAYOUT_KEY, JSON.stringify(layout))}
      >
        <Panel id="feed" defaultSize="85%" minSize="20%">
          <div
            ref={scrollRef}
            data-scroll-container="main"
            className="h-full overflow-auto px-6 py-4"
            // overflow-anchor: none — browser anchoring fights virtualizer re-measures.
            style={{ contain: "strict", overflowAnchor: "none" }}
          >
            {entries.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <p className="text-sm text-muted-foreground/50">No activity yet</p>
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
