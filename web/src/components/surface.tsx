import { layout, prepare } from "@chenglou/pretext";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { CopyIcon, SettingsIcon } from "lucide-react";
import {
  type MouseEvent,
  memo,
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

import { useStickToBottom } from "~/hooks/use-stick-to-bottom";
import { parsePanelLayout, useUserConfig } from "~/hooks/use-user-config";
import { surfaceTimelineQueryOptions } from "~/lib/queries";
import type {
  ChatTimelineItem,
  ChatTimelineMessage,
  ImageAttachment,
  MessageSource,
  StatusResponse,
} from "~/lib/types";

/* ── Types ── */

type SurfaceEntry = {
  id: string;
  timestamp: string;
} & (
  | {
      kind: "inbound";
      source: MessageSource;
      content: string;
      images?: ImageAttachment[];
      streamId?: string;
      streamName?: string;
    }
  | { kind: "outbound"; channel: "whatsapp" | "all"; content: string }
  | { kind: "hook"; eventName: string; detail: string }
  | {
      kind: "streams-response";
      content: string;
      images?: ImageAttachment[];
      streamId?: string;
      streamName?: string;
    }
);

type MeasuredSurfaceEntry = SurfaceEntry & {
  displayTime: string;
  metrics: {
    estimatedHeight: number;
    isOverflowing: boolean;
  };
};

type MeasuredInboundEntry = Extract<MeasuredSurfaceEntry, { kind: "inbound" }>;

type MeasuredStreamsResponseEntry = Extract<MeasuredSurfaceEntry, { kind: "streams-response" }>;

/* ── Helpers ── */

const SOURCE_COLORS: Record<MessageSource, string> = {
  whatsapp: "bg-emerald-500",
  web: "bg-orange-400",
  hook: "bg-violet-500",
  cron: "bg-cyan-500",
  init: "bg-gray-400",
  agent: "bg-blue-500",
  stream_outbound: "bg-amber-500",
};

const SOURCE_LABELS: Record<MessageSource, string> = {
  whatsapp: "WhatsApp",
  web: "Web",
  hook: "Hook",
  cron: "Cron",
  init: "Init",
  agent: "Agent",
  stream_outbound: "Streams",
};

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});

const MAX_LINES = 30;
const SURFACE_FONT = '400 14px "Geist Variable", sans-serif';
const SURFACE_LINE_HEIGHT = 20;
const SURFACE_MIN_BUBBLE_WIDTH = 240;
const SURFACE_BUBBLE_CHROME_WIDTH = 24;
const COPY_RESET_MS = 1500;
const SURFACE_ROW_GAP = 12;
const SURFACE_OVERSCAN_ABOVE_RATIO = 0.5;
const SURFACE_OVERSCAN_BELOW_RATIO = 1;
const SURFACE_ROW_MIN_HEIGHT = 44;
const SURFACE_BUBBLE_VERTICAL_PADDING = 16;
const SURFACE_BADGE_HEIGHT = 22;
const SURFACE_COLLAPSE_TOGGLE_HEIGHT = 24;
const SURFACE_IMAGE_HEIGHT = 200;
const SURFACE_IMAGE_GAP = 8;
const SURFACE_HOOK_TITLE_HEIGHT = 20;
const SURFACE_HOOK_DETAIL_GAP = 8;
const copyResetTimers = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>();

/**
 * Module-level cache for pretext prepare() results, keyed by text content.
 * prepare() is the expensive one-time pass (~0.04ms per text).
 * layout() is pure arithmetic (~0.0002ms) and doesn't need caching.
 */
const plainTextPrepareCache = new Map<string, ReturnType<typeof prepare>>();

function getPreparedText(text: string) {
  const cached = plainTextPrepareCache.get(text);
  if (cached) return cached;

  const prepared = prepare(text, SURFACE_FONT, { whiteSpace: "pre-wrap" });
  plainTextPrepareCache.set(text, prepared);
  return prepared;
}

function getPlainTextMetrics(text: string, maxWidth: number) {
  const prepared = getPreparedText(text);
  const { lineCount } = layout(prepared, maxWidth, SURFACE_LINE_HEIGHT);

  return {
    lineCount,
    isOverflowing: lineCount > MAX_LINES,
  };
}

function estimateMessageRowHeight(
  lineCount: number,
  hasBadge: boolean,
  isOverflowing: boolean,
): number {
  const visibleLines = Math.max(1, Math.min(lineCount, MAX_LINES));
  const textHeight = visibleLines * SURFACE_LINE_HEIGHT;
  const badgeHeight = hasBadge ? SURFACE_BADGE_HEIGHT : 0;
  const collapseHeight = isOverflowing ? SURFACE_COLLAPSE_TOGGLE_HEIGHT : 0;
  return Math.max(
    SURFACE_ROW_MIN_HEIGHT,
    SURFACE_BUBBLE_VERTICAL_PADDING + badgeHeight + textHeight + collapseHeight,
  );
}

function estimateHookRowHeight(detail: string): number {
  if (!detail) return SURFACE_ROW_MIN_HEIGHT;
  const { lineCount } = getPlainTextMetrics(detail, 520);
  return Math.max(
    SURFACE_ROW_MIN_HEIGHT,
    SURFACE_BUBBLE_VERTICAL_PADDING +
      SURFACE_HOOK_TITLE_HEIGHT +
      SURFACE_HOOK_DETAIL_GAP +
      Math.max(1, lineCount) * SURFACE_LINE_HEIGHT,
  );
}

function formatTime(iso: string): string {
  try {
    return timeFormatter.format(new Date(iso));
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
        images: msg.images,
        streamId: item.streamId,
        streamName: item.streamName,
      });
      continue;
    }

    if (item.kind === "message" && item.role === "assistant") {
      entries.push({
        id: item.id,
        timestamp: item.createdAt,
        kind: "streams-response",
        content: item.content,
        images: item.images,
        streamId: item.streamId,
        streamName: item.streamName,
      });
      continue;
    }

    if (item.kind === "tool") {
      // Skip all tool calls — only user messages and streams responses shown
      // (mirrors WhatsApp: user message in, streams final text response out)
    }
  }

  return entries;
}

function getSurfaceBubbleMaxWidth(viewportWidth: number): number {
  return Math.max(SURFACE_MIN_BUBBLE_WIDTH, viewportWidth - 92);
}

function getMeasurementWidth(maxWidth: number): number {
  return Math.max(SURFACE_MIN_BUBBLE_WIDTH, maxWidth - SURFACE_BUBBLE_CHROME_WIDTH);
}

/**
 * Synchronously measure a single entry using pretext.
 *
 * This is fast because:
 * - prepare() results are cached in plainTextPrepareCache by text content
 * - layout() is pure arithmetic (~0.0002ms per call)
 *
 * For 200 entries, total measurement time is ~0.04ms (all cache hits).
 * First-time measurement of 200 unique texts is ~8ms (prepare + layout).
 */
function measureEntry(entry: SurfaceEntry, bubbleMaxWidth: number): MeasuredSurfaceEntry {
  const measurementWidth = getMeasurementWidth(bubbleMaxWidth);
  const displayTime = formatTime(entry.timestamp);
  switch (entry.kind) {
    case "inbound":
    case "streams-response": {
      const metrics = getPlainTextMetrics(entry.content, measurementWidth);
      const imageCount = entry.images?.length ?? 0;
      const imageHeight =
        imageCount > 0 ? imageCount * SURFACE_IMAGE_HEIGHT + imageCount * SURFACE_IMAGE_GAP : 0;
      return {
        ...entry,
        displayTime,
        metrics: {
          estimatedHeight:
            estimateMessageRowHeight(
              metrics.lineCount,
              !!entry.streamName,
              metrics.isOverflowing,
            ) + imageHeight,
          isOverflowing: metrics.isOverflowing,
        },
      };
    }
    case "outbound": {
      const metrics = getPlainTextMetrics(entry.content, measurementWidth);
      return {
        ...entry,
        displayTime,
        metrics: {
          estimatedHeight: estimateMessageRowHeight(
            metrics.lineCount,
            false,
            metrics.isOverflowing,
          ),
          isOverflowing: metrics.isOverflowing,
        },
      };
    }
    case "hook":
      return {
        ...entry,
        displayTime,
        metrics: {
          estimatedHeight: estimateHookRowHeight(entry.detail),
          isOverflowing: false,
        },
      };
  }
}

/* ── Collapsible Content Wrapper ── */

function PlainTextBlock({
  text,
  isOverflowing,
  fadeClassName = "from-card",
  onExpandToggle,
}: {
  text: string;
  isOverflowing: boolean;
  fadeClassName?: string;
  onExpandToggle?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="relative">
      <div
        style={
          !expanded
            ? {
                maxHeight: `${MAX_LINES * SURFACE_LINE_HEIGHT}px`,
                overflow: "hidden",
              }
            : undefined
        }
      >
        <MarkdownContent content={text} />
      </div>
      {isOverflowing && !expanded && (
        <div
          className={`absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t ${fadeClassName} to-transparent pointer-events-none`}
        />
      )}
      {(isOverflowing || expanded) && (
        <button
          type="button"
          onClick={() => {
            setExpanded((v) => !v);
            onExpandToggle?.();
          }}
          className="mt-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          {expanded ? "Show less" : "Read more"}
        </button>
      )}
    </div>
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
          style={{ maxHeight: `${SURFACE_IMAGE_HEIGHT}px` }}
        />
      ))}
    </div>
  );
}

async function handleSurfaceCopyClick(event: MouseEvent<HTMLButtonElement>, text: string) {
  const button = event.currentTarget;
  await navigator.clipboard.writeText(text);

  button.dataset.copied = "true";
  button.title = "Copied";

  const existingTimer = copyResetTimers.get(button);
  if (existingTimer) clearTimeout(existingTimer);

  const timer = setTimeout(() => {
    if (!button.isConnected) return;
    delete button.dataset.copied;
    button.title = "Copy message";
  }, COPY_RESET_MS);

  copyResetTimers.set(button, timer);
}

function MessageCopyButton({ text }: { text: string }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        void handleSurfaceCopyClick(event, text);
      }}
      className="absolute bottom-1.5 right-1.5 p-1 rounded text-muted-foreground/40 hover:text-muted-foreground data-[copied=true]:text-emerald-500 data-[copied=true]:hover:text-emerald-500 opacity-60 hover:opacity-100 data-[copied=true]:opacity-100 data-[copied=true]:hover:opacity-100 transition-opacity cursor-pointer"
      title="Copy message"
    >
      <CopyIcon className="w-3.5 h-3.5" />
    </button>
  );
}

function findVirtualIndex(offsets: number[], target: number): number {
  let low = 0;
  let high = offsets.length - 1;
  let result = offsets.length;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (offsets[mid]! >= target) {
      result = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  return result;
}

/* ── Entry Renderers ── */

function StreamBadge({ streamId, streamName }: { streamId?: string; streamName?: string }) {
  const queryClient = useQueryClient();

  if (!streamName) return null;

  // Look up piSessionId from the status cache
  let piSessionId: string | undefined;
  if (streamId) {
    const status = queryClient.getQueryData<StatusResponse>(["status"]);
    piSessionId = status?.streams?.find((s) => s.id === streamId)?.piSessionId ?? undefined;
  }

  const badgeClasses =
    "inline-block text-[10px] font-medium text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900/40 rounded px-1.5 py-0.5 mb-1";

  if (!piSessionId) {
    return <span className={badgeClasses}>{streamName}</span>;
  }

  return (
    <Link
      to="/streams/$piSessionId"
      params={{ piSessionId }}
      className={`${badgeClasses} cursor-pointer hover:bg-blue-200 dark:hover:bg-blue-900/60 transition-colors`}
    >
      {streamName}
    </Link>
  );
}

const InboundEntry = memo(function InboundEntry({
  entry,
  onExpandToggle,
}: {
  entry: MeasuredInboundEntry;
  onExpandToggle?: () => void;
}) {
  const displayContent = entry.content;

  return (
    <div className="flex gap-3 items-start">
      <div className="flex flex-col items-center gap-1 pt-0.5 shrink-0 w-16">
        <span className="text-[10px] text-muted-foreground/60">{entry.displayTime}</span>
        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${SOURCE_COLORS[entry.source]}`} />
          <span className="text-[10px] font-medium text-muted-foreground">
            {SOURCE_LABELS[entry.source]}
          </span>
        </div>
      </div>
      <div className="group/msg relative flex-1 min-w-0 rounded-lg border border-border bg-card px-3 py-2">
        <StreamBadge streamId={entry.streamId} streamName={entry.streamName} />
        <PlainTextBlock
          text={displayContent}
          isOverflowing={entry.metrics.isOverflowing}
          onExpandToggle={onExpandToggle}
        />
        {entry.images && entry.images.length > 0 && <ImageStack images={entry.images} />}
        <MessageCopyButton text={displayContent} />
      </div>
    </div>
  );
});

const OutboundEntry = memo(function OutboundEntry({
  entry,
}: {
  entry: MeasuredSurfaceEntry & { kind: "outbound" };
}) {
  const isWhatsApp = entry.channel === "whatsapp";
  return (
    <div className="flex gap-3 items-start">
      <div className="flex flex-col items-center gap-1 pt-0.5 shrink-0 w-16">
        <span className="text-[10px] text-muted-foreground/60">{entry.displayTime}</span>
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
        <MarkdownContent content={entry.content} />
      </div>
    </div>
  );
});

const StreamsResponseEntry = memo(function StreamsResponseEntry({
  entry,
  onExpandToggle,
}: {
  entry: MeasuredStreamsResponseEntry;
  onExpandToggle?: () => void;
}) {
  return (
    <div className="flex gap-3 items-start">
      <div className="flex flex-col items-center gap-1 pt-0.5 shrink-0 w-16">
        <span className="text-[10px] text-muted-foreground/60">{entry.displayTime}</span>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-blue-400" />
          <span className="text-[10px] font-medium text-muted-foreground">Agent</span>
        </div>
      </div>
      <div className="group/msg relative flex-1 min-w-0 rounded-lg border border-border bg-muted/30 px-3 py-2">
        <StreamBadge streamId={entry.streamId} streamName={entry.streamName} />
        <PlainTextBlock
          text={entry.content}
          isOverflowing={entry.metrics.isOverflowing}
          fadeClassName="from-muted/30"
          onExpandToggle={onExpandToggle}
        />
        {entry.images && entry.images.length > 0 && <ImageStack images={entry.images} />}
        <MessageCopyButton text={entry.content} />
      </div>
    </div>
  );
});

const HookEntry = memo(function HookEntry({
  entry,
}: {
  entry: MeasuredSurfaceEntry & { kind: "hook" };
}) {
  return (
    <div className="flex gap-3 items-start">
      <div className="flex flex-col items-center gap-1 pt-0.5 shrink-0 w-16">
        <span className="text-[10px] text-muted-foreground/60">{entry.displayTime}</span>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-violet-500" />
          <span className="text-[10px] font-medium text-muted-foreground">Hook</span>
        </div>
      </div>
      <div className="flex-1 min-w-0 rounded-lg border border-violet-500/25 bg-violet-500/5 px-3 py-2">
        <p className="text-xs font-medium text-muted-foreground mb-1">{entry.eventName}</p>
        {entry.detail && (
          <MarkdownContent content={entry.detail} />
        )}
      </div>
    </div>
  );
});

const SurfaceEntryRenderer = memo(function SurfaceEntryRenderer({
  entry,
  onExpandToggle,
}: {
  entry: MeasuredSurfaceEntry;
  onExpandToggle?: () => void;
}) {
  switch (entry.kind) {
    case "inbound":
      return <InboundEntry entry={entry as MeasuredInboundEntry} onExpandToggle={onExpandToggle} />;
    case "outbound":
      return <OutboundEntry entry={entry} />;
    case "streams-response":
      return (
        <StreamsResponseEntry
          entry={entry as MeasuredStreamsResponseEntry}
          onExpandToggle={onExpandToggle}
        />
      );
    case "hook":
      return <HookEntry entry={entry} />;
  }
});

/* ── Main Component ── */

const rootApi = getRouteApi("__root__");

const CHAT_LAYOUT_KEY = "panel:chat-layout";
const CHAT_LAYOUT_DEFAULT: Record<string, number> = { feed: 85, input: 15 };

export function Surface() {
  const { apiClient, sendMessage } = rootApi.useRouteContext();
  const { config, setConfig } = useUserConfig();
  const chatLayout = parsePanelLayout(config, CHAT_LAYOUT_KEY, CHAT_LAYOUT_DEFAULT);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([]);
  const [surfaceWidth, setSurfaceWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [initialPositionReady, setInitialPositionReady] = useState(false);
  const [visibleLayoutReady, setVisibleLayoutReady] = useState(false);
  const [measuredHeights, setMeasuredHeights] = useState<Record<string, number>>({});
  const [measurementToken, setMeasurementToken] = useState(0);
  const invalidateMeasurement = useCallback(() => setMeasurementToken((t) => t + 1), []);

  const [isSending, setIsSending] = useState(false);
  const { data: skillsData } = useQuery({
    queryKey: ["skills"],
    queryFn: () => apiClient.listSkills(),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  // Timeline from Query cache — seeded by route loader, appended by WS bridge.
  const { data: timeline = [] } = useQuery(surfaceTimelineQueryOptions());

  const { viewportRef, isAtBottomRef, scrollToBottom, engageAndScroll } = useStickToBottom();
  const prevEntryCountRef = useRef(0);
  const didInitialBottomPaintRef = useRef(false);
  const rowElementsRef = useRef(new Map<string, HTMLDivElement>());
  const setViewportRef = useCallback(
    (node: HTMLDivElement | null) => {
      viewportRef.current = node;
      if (!node) return;
      setSurfaceWidth(node.clientWidth);
      setViewportHeight(node.clientHeight);
      setScrollTop(node.scrollTop);
    },
    [viewportRef],
  );

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;

    const resizeObserver = new ResizeObserver(() => {
      setSurfaceWidth(node.clientWidth);
      setViewportHeight(node.clientHeight);
    });
    resizeObserver.observe(node);
    const onScroll = () => {
      setScrollTop(node.scrollTop);
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      node.removeEventListener("scroll", onScroll);
      resizeObserver.disconnect();
    };
  }, [viewportRef]);

  // Recompute only when timeline reference changes (setQueryData creates new arrays)
  const entries = useMemo(() => timelineToSurfaceEntries(timeline), [timeline]);
  const bubbleMaxWidth = useMemo(
    () => (surfaceWidth > 0 ? getSurfaceBubbleMaxWidth(surfaceWidth) : null),
    [surfaceWidth],
  );
  const measurementReady = bubbleMaxWidth !== null;

  /**
   * Synchronous measurement of all entries via pretext.
   *
   * This replaces the old async surfaceMeasurementStore. It's fast because:
   * - prepare() results are cached in plainTextPrepareCache (keyed by text)
   * - layout() is pure arithmetic (~0.0002ms per entry)
   *
   * When a new message appends, only its prepare() runs (~0.04ms). All
   * existing entries hit the cache, so layout() is the only work — ~0.04ms
   * total for 200 entries. No fallback heights, no async, no flash.
   */
  const measuredEntries = useMemo(() => {
    if (bubbleMaxWidth === null) return [] as MeasuredSurfaceEntry[];
    return entries.map((entry) => measureEntry(entry, bubbleMaxWidth));
  }, [entries, bubbleMaxWidth]);

  const virtualRows = useMemo(() => {
    const offsets: number[] = new Array(measuredEntries.length);
    let runningOffset = 0;
    for (let index = 0; index < measuredEntries.length; index++) {
      offsets[index] = runningOffset;
      const entry = measuredEntries[index]!;
      const rowHeight = measuredHeights[entry.id] ?? entry.metrics.estimatedHeight;
      runningOffset += rowHeight + SURFACE_ROW_GAP;
    }
    const totalHeight = measuredEntries.length === 0 ? 0 : runningOffset - SURFACE_ROW_GAP;
    return {
      offsets,
      totalHeight,
    };
  }, [measuredEntries, measuredHeights]);

  const visibleVirtualRows = useMemo(() => {
    if (measuredEntries.length === 0) return [];

    const overscanAbove = viewportHeight * SURFACE_OVERSCAN_ABOVE_RATIO;
    const overscanBelow = viewportHeight * SURFACE_OVERSCAN_BELOW_RATIO;
    const windowStart = Math.max(0, scrollTop - overscanAbove);
    const windowEnd = scrollTop + viewportHeight + overscanBelow;

    const startIndex = Math.max(0, findVirtualIndex(virtualRows.offsets, windowStart) - 1);
    let endIndex = findVirtualIndex(virtualRows.offsets, windowEnd);
    if (endIndex === measuredEntries.length) endIndex = measuredEntries.length - 1;

    const items = [];
    for (let index = startIndex; index <= endIndex; index++) {
      items.push({
        entry: measuredEntries[index]!,
        top: virtualRows.offsets[index]!,
      });
    }
    return items;
  }, [measuredEntries, scrollTop, viewportHeight, virtualRows]);

  useLayoutEffect(() => {
    if (!measurementReady || visibleVirtualRows.length === 0) return;

    let hasAllNodes = true;
    let changed = false;

    setMeasuredHeights((prev) => {
      const next = { ...prev };

      for (const { entry } of visibleVirtualRows) {
        const node = rowElementsRef.current.get(entry.id);
        if (!node) {
          hasAllNodes = false;
          continue;
        }
        const measuredHeight = Math.ceil(node.getBoundingClientRect().height);
        if (next[entry.id] !== measuredHeight) {
          next[entry.id] = measuredHeight;
          changed = true;
        }
      }

      return changed ? next : prev;
    });

    if (hasAllNodes) {
      setVisibleLayoutReady(true);
    }
  }, [measurementReady, visibleVirtualRows, measurementToken]);

  useLayoutEffect(() => {
    const node = viewportRef.current;
    if (
      !node ||
      !measurementReady ||
      !visibleLayoutReady ||
      didInitialBottomPaintRef.current ||
      measuredEntries.length === 0
    )
      return;

    node.scrollTop = node.scrollHeight;
    isAtBottomRef.current = true;
    setScrollTop(node.scrollTop);
    didInitialBottomPaintRef.current = true;
    setInitialPositionReady(true);
  }, [
    isAtBottomRef,
    measuredEntries.length,
    measurementReady,
    viewportRef,
    virtualRows.totalHeight,
    visibleLayoutReady,
  ]);

  // Re-settle scroll when virtual height changes after initial paint.
  // Catches measurement settling: bottom rows render after the initial scroll
  // repositions the viewport, and their actual heights differ from estimates.
  useLayoutEffect(() => {
    const node = viewportRef.current;
    if (!node || !didInitialBottomPaintRef.current || !isAtBottomRef.current) return;
    scrollToBottom();
    setScrollTop(node.scrollTop);
  }, [virtualRows.totalHeight, viewportRef, isAtBottomRef, scrollToBottom]);

  useEffect(() => {
    if (measuredEntries.length === 0) {
      didInitialBottomPaintRef.current = false;
      setInitialPositionReady(true);
    }
  }, [measuredEntries.length]);

  // Auto-scroll when new entries arrive while pinned to bottom
  useEffect(() => {
    const prev = prevEntryCountRef.current;
    prevEntryCountRef.current = measuredEntries.length;
    if (prev > 0 && measuredEntries.length > prev && isAtBottomRef.current) {
      scrollToBottom();
    }
  }, [measuredEntries.length, isAtBottomRef, scrollToBottom]);

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

  const openSettings = useCallback(() => {
    setSettingsOpen(true);
  }, []);

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
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
      engageAndScroll();

      try {
        await sendMessage(text || "(image)", images);
        setPendingImages([]);
      } catch (error) {
        toast.error("Failed to send message");
        console.error("handleSubmit send failed:", error);
      } finally {
        setIsSending(false);
      }
    },
    [engageAndScroll, sendMessage],
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
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
            <SettingsIcon className="w-4 h-4" />
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
        {/* Activity feed */}
        <Panel id="feed" defaultSize="85%" minSize="20%">
          <div
            ref={setViewportRef}
            data-scroll-container="main"
            className="h-full overflow-auto px-6 py-4"
            style={{
              visibility:
                initialPositionReady && measurementReady && visibleLayoutReady
                  ? "visible"
                  : "hidden",
            }}
          >
            {entries.length === 0 && (
              <div className="flex items-center justify-center h-full">
                <p className="text-sm text-muted-foreground/50">No activity yet</p>
              </div>
            )}
            {entries.length > 0 && (
              <div className="relative" style={{ height: `${virtualRows.totalHeight}px` }}>
                {visibleVirtualRows.map(({ entry, top }) => (
                  <div
                    key={entry.id}
                    ref={(node) => {
                      if (node) {
                        rowElementsRef.current.set(entry.id, node);
                      } else {
                        rowElementsRef.current.delete(entry.id);
                      }
                    }}
                    className="absolute left-0 right-0"
                    style={{ top: `${top}px` }}
                  >
                    <SurfaceEntryRenderer entry={entry} onExpandToggle={invalidateMeasurement} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </Panel>

        <HorizontalResizeHandle />

        <Panel id="input" defaultSize="15%" minSize="9%">
          <MessageInput
            draftKey="__surface__"
            isSending={isSending}
            onSubmit={handleSubmit}
            pendingImages={pendingImages}
            onAddImages={addImageFiles}
            onRemoveImage={removeImage}
            skills={skillsData?.items}
            placeholder="Message streams..."
            fillHeight
            autoFocus
          />
        </Panel>
      </PanelGroup>
    </div>
  );
}
