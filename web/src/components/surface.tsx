import { layout, prepare } from "@chenglou/pretext";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { CopyIcon, SettingsIcon } from "lucide-react";
import { marked } from "marked";
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
import type { Layout as PanelLayout } from "react-resizable-panels";
import { toast } from "sonner";
import { MarkdownContent } from "~/components/common/markdown-content";
import { MessageInput } from "~/components/common/message-input";
import { HorizontalResizeHandle, Panel, PanelGroup } from "~/components/common/resizable";
import { RuntimeHealthIndicator } from "~/components/runtime-health-indicator";
import { SettingsDrawer } from "~/components/settings-drawer";

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

type SurfaceScrollRestoreState = {
  offset: number;
  width: number;
  snapshot: VirtualItem[];
  expandedIds: string[];
};

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
const SURFACE_MIN_BUBBLE_WIDTH = 240;
// px-3 + 1px border each side; pretext measures inner content width.
const SURFACE_BUBBLE_CHROME_WIDTH = 26;
const COPY_RESET_MS = 1500;
const SURFACE_ROW_GAP = 12;
const SURFACE_OVERSCAN = 8;
const SURFACE_SCROLL_RESTORE_WIDTH_TOLERANCE = 32;
const SURFACE_SCROLL_RESTORE_DEBUG = true;
const EMPTY_SURFACE_SCROLL_SNAPSHOT: VirtualItem[] = [];
let surfaceScrollRestoreState: SurfaceScrollRestoreState | null = null;
const SURFACE_ROW_MIN_HEIGHT = 44;
const SURFACE_BADGE_HEIGHT = 22;
const SURFACE_COLLAPSE_TOGGLE_HEIGHT = 24;
const SURFACE_IMAGE_HEIGHT = 200;
const SURFACE_IMAGE_GAP = 8;
const SURFACE_HOOK_TITLE_HEIGHT = 20;
const SURFACE_HOOK_DETAIL_GAP = 8;

// Markdown estimator constants derived from styles.css + browser defaults at 14px.
const FONT_SIZE_PX = 14;
const MARKDOWN_LINE_HEIGHT_RATIO = 1.65;
const MARKDOWN_LINE_HEIGHT_PX = FONT_SIZE_PX * MARKDOWN_LINE_HEIGHT_RATIO;
const BUBBLE_CHROME_PX = 2 * 1 + 2 * 8;
const PARAGRAPH_MARGIN_PX = 0.6 * FONT_SIZE_PX;
const LIST_INDENT_PX = 1.5 * FONT_SIZE_PX;
const LIST_MARGIN_PX = 0.5 * FONT_SIZE_PX;
const BQ_INDENT_PX = 0.8 * FONT_SIZE_PX + 3;
const BQ_MARGIN_PX = 0.5 * FONT_SIZE_PX;
const CODE_PADDING_PX = 2 * 0.8 * FONT_SIZE_PX;
const CODE_LINE_HEIGHT_PX = 0.8 * FONT_SIZE_PX * 1.5;
const CODE_MARGIN_PX = 1 * FONT_SIZE_PX;
const HR_HEIGHT_PX = 1;
const HR_MARGIN_PX = 0.5 * FONT_SIZE_PX;
const HEADING_FONT_SIZE_EM: Record<number, number> = {
  1: 2,
  2: 1.5,
  3: 1.17,
  4: 1,
  5: 0.83,
  6: 0.67,
};
const HEADING_MARGIN_EM: Record<number, number> = {
  1: 0.67,
  2: 0.83,
  3: 1,
  4: 1.33,
  5: 1.5,
  6: 1.67,
};

const copyResetTimers = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>();

const plainTextPrepareCache = new Map<string, ReturnType<typeof prepare>>();

function getPreparedText(text: string) {
  const cached = plainTextPrepareCache.get(text);
  if (cached) return cached;

  const prepared = prepare(text, SURFACE_FONT, { whiteSpace: "pre-wrap" });
  plainTextPrepareCache.set(text, prepared);
  return prepared;
}

type MarkdownTokenLite = {
  type?: string;
  text?: unknown;
  raw?: unknown;
  tokens?: MarkdownTokenLite[];
  items?: MarkdownTokenLite[];
  rows?: unknown[];
  depth?: unknown;
};

type BlockMetrics = { height: number; marginTop: number; marginBottom: number };

const markdownTokenCache = new Map<string, MarkdownTokenLite[]>();

function getMarkdownTokens(text: string): MarkdownTokenLite[] {
  const cached = markdownTokenCache.get(text);
  if (cached) return cached;
  const tokens = marked.lexer(text) as MarkdownTokenLite[];
  markdownTokenCache.set(text, tokens);
  return tokens;
}

// Soft \n inside a paragraph collapses to space; pretext pre-wrap would treat as hard break.
function collapseSoftBreaks(text: string): string {
  return text.replace(/[ \t]*\n[ \t]*/g, " ");
}

function measureInlineLines(text: string, maxWidth: number, lineHeight: number): number {
  if (!text) return 1;
  const collapsed = collapseSoftBreaks(text);
  const prepared = getPreparedText(collapsed);
  const { lineCount } = layout(prepared, Math.max(1, maxWidth), lineHeight);
  return Math.max(1, lineCount);
}

function measureBlock(token: MarkdownTokenLite, maxWidth: number): BlockMetrics {
  switch (token.type) {
    case "paragraph":
    case "text": {
      const raw = String(token.text ?? token.raw ?? "");
      const lines = measureInlineLines(raw, maxWidth, MARKDOWN_LINE_HEIGHT_PX);
      return {
        height: lines * MARKDOWN_LINE_HEIGHT_PX,
        marginTop: PARAGRAPH_MARGIN_PX,
        marginBottom: PARAGRAPH_MARGIN_PX,
      };
    }
    case "heading": {
      const depth = Math.min(Math.max(Number(token.depth) || 2, 1), 6);
      const fontSize = (HEADING_FONT_SIZE_EM[depth] ?? 1) * FONT_SIZE_PX;
      const lh = fontSize * MARKDOWN_LINE_HEIGHT_RATIO;
      const lines = measureInlineLines(String(token.text ?? ""), maxWidth, lh);
      const marginPx = (HEADING_MARGIN_EM[depth] ?? 1) * fontSize;
      return { height: lines * lh, marginTop: marginPx, marginBottom: marginPx };
    }
    case "code": {
      const codeText = String(token.text ?? "");
      const codeLines = codeText.length === 0 ? 1 : codeText.split("\n").length;
      return {
        height: CODE_PADDING_PX + codeLines * CODE_LINE_HEIGHT_PX,
        marginTop: CODE_MARGIN_PX,
        marginBottom: CODE_MARGIN_PX,
      };
    }
    case "blockquote": {
      const inner = (token.tokens ?? []).map((t) => measureBlock(t, maxWidth - BQ_INDENT_PX));
      return {
        height: stackBlocks(inner),
        marginTop: BQ_MARGIN_PX,
        marginBottom: BQ_MARGIN_PX,
      };
    }
    case "list": {
      const items = token.items ?? [];
      let total = 0;
      for (const item of items) {
        const inner = (item.tokens ?? []).map((t) => measureBlock(t, maxWidth - LIST_INDENT_PX));
        total += stackBlocks(inner);
      }
      return { height: total, marginTop: LIST_MARGIN_PX, marginBottom: LIST_MARGIN_PX };
    }
    case "table": {
      const rowCount = 1 + (Array.isArray(token.rows) ? token.rows.length : 0);
      return {
        height: rowCount * MARKDOWN_LINE_HEIGHT_PX,
        marginTop: PARAGRAPH_MARGIN_PX,
        marginBottom: PARAGRAPH_MARGIN_PX,
      };
    }
    case "hr":
      return { height: HR_HEIGHT_PX, marginTop: HR_MARGIN_PX, marginBottom: HR_MARGIN_PX };
    case "space":
      return { height: 0, marginTop: 0, marginBottom: 0 };
    default: {
      const lines = measureInlineLines(
        String(token.text ?? token.raw ?? ""),
        maxWidth,
        MARKDOWN_LINE_HEIGHT_PX,
      );
      return {
        height: lines * MARKDOWN_LINE_HEIGHT_PX,
        marginTop: PARAGRAPH_MARGIN_PX,
        marginBottom: PARAGRAPH_MARGIN_PX,
      };
    }
  }
}

function stackBlocks(blocks: BlockMetrics[]): number {
  const visible = blocks.filter((b) => b.height > 0);
  if (visible.length === 0) return 0;
  let total = visible[0]!.height;
  for (let i = 1; i < visible.length; i++) {
    total += Math.max(visible[i - 1]!.marginBottom, visible[i]!.marginTop) + visible[i]!.height;
  }
  return total;
}

function getMarkdownMetrics(text: string, maxWidth: number) {
  const tokens = getMarkdownTokens(text);
  const blocks = tokens.map((t) => measureBlock(t, maxWidth));
  const rawTextHeight = stackBlocks(blocks);
  const clampHeight = MAX_LINES * MARKDOWN_LINE_HEIGHT_PX;
  const isOverflowing = rawTextHeight > clampHeight;
  return {
    textHeight: isOverflowing ? clampHeight : rawTextHeight,
    isOverflowing,
  };
}

function estimateMessageRowHeight(
  textHeight: number,
  hasBadge: boolean,
  isOverflowing: boolean,
): number {
  const badgeHeight = hasBadge ? SURFACE_BADGE_HEIGHT : 0;
  const collapseHeight = isOverflowing ? SURFACE_COLLAPSE_TOGGLE_HEIGHT : 0;
  return Math.max(
    SURFACE_ROW_MIN_HEIGHT,
    BUBBLE_CHROME_PX + badgeHeight + textHeight + collapseHeight,
  );
}

function estimateHookRowHeight(detail: string, maxWidth: number): number {
  if (!detail) return SURFACE_ROW_MIN_HEIGHT;
  const tokens = getMarkdownTokens(detail);
  const blocks = tokens.map((t) => measureBlock(t, maxWidth));
  const textHeight = stackBlocks(blocks);
  return Math.max(
    SURFACE_ROW_MIN_HEIGHT,
    BUBBLE_CHROME_PX + SURFACE_HOOK_TITLE_HEIGHT + SURFACE_HOOK_DETAIL_GAP + textHeight,
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function logSurfaceScrollRestore(message: string, details?: unknown) {
  if (!SURFACE_SCROLL_RESTORE_DEBUG) return;

  if (details === undefined) {
    console.log(`[surface scroll restore] ${message}`);
    return;
  }

  console.log(`[surface scroll restore] ${message}`, details);
}

function readSurfaceScrollRestoreState(
  measuredEntries: MeasuredSurfaceEntry[],
  surfaceWidth: number,
): SurfaceScrollRestoreState | null {
  try {
    const parsed = surfaceScrollRestoreState;
    if (!parsed) {
      logSurfaceScrollRestore("no saved snapshot");
      return null;
    }

    logSurfaceScrollRestore("saved snapshot found", {
      savedOffset: parsed.offset,
      savedWidth: parsed.width,
      currentWidth: surfaceWidth,
      currentEntryCount: measuredEntries.length,
      snapshotLength: Array.isArray(parsed.snapshot) ? parsed.snapshot.length : null,
    });

    if (!isFiniteNumber(parsed.offset) || parsed.offset < 0) {
      logSurfaceScrollRestore("discarding snapshot: invalid offset", parsed.offset);
      return null;
    }
    if (!isFiniteNumber(parsed.width) || parsed.width <= 0) {
      logSurfaceScrollRestore("discarding snapshot: invalid width", parsed.width);
      return null;
    }
    if (Math.abs(parsed.width - surfaceWidth) > SURFACE_SCROLL_RESTORE_WIDTH_TOLERANCE) {
      logSurfaceScrollRestore("discarding snapshot: width mismatch", {
        savedWidth: parsed.width,
        currentWidth: surfaceWidth,
      });
      return null;
    }
    if (!Array.isArray(parsed.snapshot)) {
      logSurfaceScrollRestore("discarding snapshot: snapshot is not an array");
      return null;
    }
    if (!Array.isArray(parsed.expandedIds)) {
      logSurfaceScrollRestore("discarding snapshot: expandedIds is not an array");
      return null;
    }

    for (const item of parsed.snapshot) {
      if (!isFiniteNumber(item.index) || item.index < 0) {
        logSurfaceScrollRestore("discarding snapshot: invalid item index", item);
        return null;
      }
      if (!isFiniteNumber(item.start) || !isFiniteNumber(item.size) || !isFiniteNumber(item.end)) {
        logSurfaceScrollRestore("discarding snapshot: invalid item dimensions", item);
        return null;
      }
      if (!isFiniteNumber(item.lane)) {
        logSurfaceScrollRestore("discarding snapshot: invalid item lane", item);
        return null;
      }
      if (measuredEntries[item.index]?.id !== item.key) {
        logSurfaceScrollRestore("discarding snapshot: item key mismatch", {
          index: item.index,
          savedKey: item.key,
          currentKey: measuredEntries[item.index]?.id,
        });
        return null;
      }
    }

    logSurfaceScrollRestore("accepted snapshot", {
      offset: parsed.offset,
      width: parsed.width,
      snapshotLength: parsed.snapshot.length,
    });

    return {
      offset: parsed.offset,
      width: parsed.width,
      snapshot: parsed.snapshot,
      expandedIds: parsed.expandedIds,
    };
  } catch (error) {
    logSurfaceScrollRestore("discarding snapshot: read/parse failed", error);
    return null;
  }
}

function writeSurfaceScrollRestoreState(state: SurfaceScrollRestoreState) {
  surfaceScrollRestoreState = state;
  logSurfaceScrollRestore("saved snapshot", {
    offset: state.offset,
    snapshotLength: state.snapshot.length,
    expandedCount: state.expandedIds.length,
  });
}

// Sum of pretext estimateSize values + gaps; seeds initialOffset to the bottom.
function computeTotalEstimatedHeight(entries: MeasuredSurfaceEntry[]): number {
  if (entries.length === 0) return 0;
  let total = (entries.length - 1) * SURFACE_ROW_GAP;
  for (const entry of entries) total += entry.metrics.estimatedHeight;
  return total;
}

function measureEntry(entry: SurfaceEntry, bubbleMaxWidth: number): MeasuredSurfaceEntry {
  const measurementWidth = getMeasurementWidth(bubbleMaxWidth);
  const displayTime = formatTime(entry.timestamp);
  switch (entry.kind) {
    case "inbound":
    case "streams-response": {
      const textMetrics = getMarkdownMetrics(entry.content, measurementWidth);
      const imageCount = entry.images?.length ?? 0;
      const imageHeight =
        imageCount > 0 ? imageCount * SURFACE_IMAGE_HEIGHT + imageCount * SURFACE_IMAGE_GAP : 0;
      return {
        ...entry,
        displayTime,
        metrics: {
          estimatedHeight:
            estimateMessageRowHeight(
              textMetrics.textHeight,
              !!entry.streamName,
              textMetrics.isOverflowing,
            ) + imageHeight,
          isOverflowing: textMetrics.isOverflowing,
        },
      };
    }
    case "outbound": {
      const textMetrics = getMarkdownMetrics(entry.content, measurementWidth);
      return {
        ...entry,
        displayTime,
        metrics: {
          estimatedHeight: estimateMessageRowHeight(
            textMetrics.textHeight,
            false,
            textMetrics.isOverflowing,
          ),
          isOverflowing: textMetrics.isOverflowing,
        },
      };
    }
    case "hook":
      return {
        ...entry,
        displayTime,
        metrics: {
          estimatedHeight: estimateHookRowHeight(entry.detail, measurementWidth),
          isOverflowing: false,
        },
      };
  }
}

/* ── Collapsible Content Wrapper ── */

function PlainTextBlock({
  text,
  isOverflowing,
  expanded,
  onToggle,
  fadeClassName = "from-card",
}: {
  text: string;
  isOverflowing: boolean;
  expanded: boolean;
  onToggle: () => void;
  fadeClassName?: string;
}) {
  return (
    <div className="relative">
      <div
        style={
          !expanded
            ? {
                maxHeight: `${MAX_LINES * MARKDOWN_LINE_HEIGHT_PX}px`,
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
          onClick={onToggle}
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

/* ── Entry Renderers ── */

function StreamBadge({ streamId, streamName }: { streamId?: string; streamName?: string }) {
  const queryClient = useQueryClient();

  if (!streamName) return null;

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
  expanded,
  onToggle,
}: {
  entry: MeasuredInboundEntry;
  expanded: boolean;
  onToggle: () => void;
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
          expanded={expanded}
          onToggle={onToggle}
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
  expanded,
  onToggle,
}: {
  entry: MeasuredStreamsResponseEntry;
  expanded: boolean;
  onToggle: () => void;
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
          expanded={expanded}
          onToggle={onToggle}
          fadeClassName="from-muted/30"
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
        {entry.detail && <MarkdownContent content={entry.detail} />}
      </div>
    </div>
  );
});

const SurfaceEntryRenderer = memo(function SurfaceEntryRenderer({
  entry,
  expanded,
  onToggle,
}: {
  entry: MeasuredSurfaceEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  switch (entry.kind) {
    case "inbound":
      return (
        <InboundEntry
          entry={entry as MeasuredInboundEntry}
          expanded={expanded}
          onToggle={onToggle}
        />
      );
    case "outbound":
      return <OutboundEntry entry={entry} />;
    case "streams-response":
      return (
        <StreamsResponseEntry
          entry={entry as MeasuredStreamsResponseEntry}
          expanded={expanded}
          onToggle={onToggle}
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
  const { sendMessage } = rootApi.useRouteContext();
  const { config, setConfig } = useUserConfig();
  const chatLayout = parsePanelLayout(config, CHAT_LAYOUT_KEY, CHAT_LAYOUT_DEFAULT);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([]);
  const [surfaceWidth, setSurfaceWidth] = useState(0);
  const [isSending, setIsSending] = useState(false);

  const { data: timeline = [] } = useQuery(surfaceTimelineQueryOptions());

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const measuredEntriesRef = useRef<MeasuredSurfaceEntry[]>([]);
  const surfaceWidthRef = useRef(surfaceWidth);
  const measurementReadyRef = useRef(false);
  const restoredScrollStateRef = useRef<SurfaceScrollRestoreState | null | undefined>(undefined);
  const initialOffsetRef = useRef<number | null>(null);
  // Lifted out of PlainTextBlock so it survives row recycle and matches snapshot heights.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const expandedIdsRef = useRef(expandedIds);
  const setViewportRef = useCallback((node: HTMLDivElement | null) => {
    viewportRef.current = node;
    if (!node) return;
    setSurfaceWidth(node.clientWidth);
  }, []);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;

    const resizeObserver = new ResizeObserver(() => {
      setSurfaceWidth(node.clientWidth);
    });
    resizeObserver.observe(node);
    return () => resizeObserver.disconnect();
  }, []);

  const entries = useMemo(() => timelineToSurfaceEntries(timeline), [timeline]);
  const bubbleMaxWidth = useMemo(
    () => (surfaceWidth > 0 ? getSurfaceBubbleMaxWidth(surfaceWidth) : null),
    [surfaceWidth],
  );
  const measurementReady = bubbleMaxWidth !== null;

  // Mirrors for the unmount-capture effect.
  useLayoutEffect(() => {
    surfaceWidthRef.current = surfaceWidth;
    measurementReadyRef.current = measurementReady;
    expandedIdsRef.current = expandedIds;
  });

  const measuredEntries = useMemo(() => {
    if (bubbleMaxWidth === null) return [] as MeasuredSurfaceEntry[];
    return entries.map((entry) => measureEntry(entry, bubbleMaxWidth));
  }, [entries, bubbleMaxWidth]);
  // useVirtualizer reads estimateSize / getItemKey synchronously; ref must be set during render.
  measuredEntriesRef.current = measuredEntries;

  // One-shot init: restore snapshot, else seed initialOffset to bottom.
  if (measurementReady && restoredScrollStateRef.current === undefined) {
    const restored = readSurfaceScrollRestoreState(measuredEntries, surfaceWidth);
    restoredScrollStateRef.current = restored;
    if (restored) {
      initialOffsetRef.current = restored.offset;
      const validIds = new Set(measuredEntries.map((e) => e.id));
      const restoredExpanded = restored.expandedIds.filter((id) => validIds.has(id));
      if (restoredExpanded.length > 0) setExpandedIds(new Set(restoredExpanded));
    } else {
      const total = computeTotalEstimatedHeight(measuredEntries);
      const viewportHeight = viewportRef.current?.clientHeight ?? 0;
      initialOffsetRef.current = Math.max(0, total - viewportHeight);
      logSurfaceScrollRestore("computed initial bottom offset", {
        total,
        viewportHeight,
        initialOffset: initialOffsetRef.current,
      });
    }
  }

  const getVirtualItemKey = useCallback(
    (index: number) => measuredEntriesRef.current[index]?.id ?? index,
    [],
  );
  const estimateVirtualItemSize = useCallback(
    (index: number) =>
      measuredEntriesRef.current[index]?.metrics.estimatedHeight ?? SURFACE_ROW_MIN_HEIGHT,
    [],
  );
  const getScrollElement = useCallback(() => viewportRef.current, []);

  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: measuredEntries.length,
    enabled: measurementReady,
    estimateSize: estimateVirtualItemSize,
    gap: SURFACE_ROW_GAP,
    getItemKey: getVirtualItemKey,
    getScrollElement,
    initialMeasurementsCache:
      restoredScrollStateRef.current?.snapshot ?? EMPTY_SURFACE_SCROLL_SNAPSHOT,
    initialOffset: initialOffsetRef.current ?? 0,
    overscan: SURFACE_OVERSCAN,
    useFlushSync: false,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();

  // Stable per-id handlers so memoized rows don't churn on every Set identity change.
  // measureElement's ResizeObserver picks up the maxHeight un-clamp on commit.
  const toggleHandlersRef = useRef(new Map<string, () => void>());
  const getToggleHandler = (id: string): (() => void) => {
    const cached = toggleHandlersRef.current.get(id);
    if (cached) return cached;
    const handler = () =>
      setExpandedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    toggleHandlersRef.current.set(id, handler);
    return handler;
  };

  useEffect(() => {
    if (!measurementReady) return;
    const restored = restoredScrollStateRef.current;
    logSurfaceScrollRestore("virtualizer mounted", {
      restored: !!restored,
      initialOffset: initialOffsetRef.current ?? 0,
      snapshotLength: restored?.snapshot.length ?? 0,
      expandedCount: restored?.expandedIds.length ?? 0,
      entryCount: measuredEntries.length,
    });
  }, [measurementReady, measuredEntries.length]);

  useEffect(() => {
    return () => {
      if (!measurementReadyRef.current) return;
      writeSurfaceScrollRestoreState({
        offset: rowVirtualizer.scrollOffset ?? viewportRef.current?.scrollTop ?? 0,
        width: surfaceWidthRef.current,
        snapshot: rowVirtualizer.takeSnapshot(),
        expandedIds: Array.from(expandedIdsRef.current),
      });
    };
  }, [rowVirtualizer]);

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

  const pendingImagesRef = useRef(pendingImages);
  useEffect(() => {
    pendingImagesRef.current = pendingImages;
  });

  const handleSubmit = useCallback(
    async (text: string) => {
      const images = pendingImagesRef.current.length ? [...pendingImagesRef.current] : undefined;
      if (!text && !images?.length) return;

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
    [sendMessage],
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
        onLayoutChanged={(layout: PanelLayout) =>
          setConfig(CHAT_LAYOUT_KEY, JSON.stringify(layout))
        }
      >
        <Panel id="feed" defaultSize="85%" minSize="20%">
          <div
            ref={setViewportRef}
            data-scroll-container="main"
            className="h-full overflow-auto px-6 py-4"
            // overflow-anchor: none required — browser anchoring fights virtualizer re-measures.
            style={{ contain: "strict", overflowAnchor: "none" }}
          >
            {entries.length === 0 && (
              <div className="flex items-center justify-center h-full">
                <p className="text-sm text-muted-foreground/50">No activity yet</p>
              </div>
            )}
            {entries.length > 0 && (
              <div className="relative" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
                <div
                  className="absolute left-0 right-0 top-0 flex flex-col"
                  style={{
                    gap: `${SURFACE_ROW_GAP}px`,
                    transform: `translateY(${virtualItems[0]?.start ?? 0}px)`,
                  }}
                >
                  {virtualItems.map((virtualItem) => {
                    const entry = measuredEntries[virtualItem.index];
                    if (!entry) return null;

                    return (
                      <div
                        key={virtualItem.key}
                        data-index={virtualItem.index}
                        ref={rowVirtualizer.measureElement}
                      >
                        <SurfaceEntryRenderer
                          entry={entry}
                          expanded={expandedIds.has(entry.id)}
                          onToggle={getToggleHandler(entry.id)}
                        />
                      </div>
                    );
                  })}
                </div>
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
