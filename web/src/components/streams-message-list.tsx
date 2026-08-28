/*
 * Scroll behavior encodes four hard-won, load-bearing constraints.
 * 1. Component owns its scroll element: ancestor refs attach after child
 *    layout effects, so a parent-owned viewport left the virtualizer
 *    detached at mount and the initial scroll no-oped.
 * 2. Initial pin + auto-fill decide in a layout effect after rows commit,
 *    when geometry is measured. Deciding in onChange read estimates and
 *    fetched history mid-init, breaking end anchoring during reconcile.
 * 3. Older pages load only on real user scrolls (sync + backward): the
 *    virtualizer's offset lags programmatic scrollTo until a scroll
 *    event lands, so "near top" false-fires while at the bottom.
 * 4. The router's Suspense boundary hides/re-shows this subtree on nav:
 *    effects replay, the hidden box zeroes scrollTop, the virtualizer
 *    re-attaches a stale offset. Init is per attachment, not instance.
 * Scroll restoration is off for /streams (router.tsx).
 */
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import {
  memo,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChatMessageRow, StreamingAssistantRow } from "@/components/chat-message-row";
import { useWhyDidYouRender } from "@/hooks/use-why-did-you-render";
import type { ConversationRow } from "@/lib/conversation-rows";
import { cn } from "@/lib/utils";

const LOAD_PREVIOUS_ROW_THRESHOLD = 2;
const ESTIMATED_ROW_HEIGHT = 280;
const MARKERS_EACH_SIDE = 12;
const MARKER_ROW_HEIGHT = 24;
const STREAMING_ROW_KEY = "streaming";
const VIRTUALIZER_OVERSCAN = 2;

function userMessageForRow(
  rows: ConversationRow[],
  userMessageIndex: string[],
  rowIndex: number,
): string | undefined {
  for (let index = Math.min(rowIndex, rows.length - 1); index >= 0; index--) {
    const message = rows[index]?.message;
    if (message?.role === "user") return message.id;
  }

  for (let index = Math.max(rowIndex + 1, 0); index < rows.length; index++) {
    const message = rows[index]?.message;
    if (message?.role !== "user") continue;
    const nextUserIndex = userMessageIndex.indexOf(message.id);
    return nextUserIndex > 0 ? userMessageIndex[nextUserIndex - 1] : message.id;
  }

  return userMessageIndex.at(-1);
}

export type StreamsMessageListHandle = {
  scrollToEnd(): void;
  navigateToLatestUserMessage(): boolean;
};

type StreamsMessageListProps = {
  piSessionId: string;
  rows: ConversationRow[];
  userMessageIndex: string[];
  activeFindRowIndex?: number;
  onPruneRequested?: (entryId: string) => void;
  onForkRequested?: (entryId: string) => void;
  isSessionBusy?: boolean;
  onLoadPrevious: () => Promise<void>;
  hasPreviousPage: boolean;
  isFetchingPreviousPage: boolean;
  ref?: Ref<StreamsMessageListHandle>;
};

type MarkerNavigation = {
  targetMessageId: string;
  paddingEnd: number;
  error?: string;
};

type UserMessageMarkersProps = {
  messageIds: string[];
  activeMessageId?: string;
  windowCenterMessageId?: string;
  navigation?: MarkerNavigation;
  onSelect: (messageId: string) => void;
};

const UserMessageMarkers = memo(function UserMessageMarkers({
  messageIds,
  activeMessageId,
  windowCenterMessageId,
  navigation,
  onSelect,
}: UserMessageMarkersProps) {
  const railRef = useRef<HTMLElement>(null);
  const markerWindow = useMemo(() => {
    const requestedCenter = windowCenterMessageId ?? activeMessageId ?? messageIds.at(-1);
    const requestedIndex = requestedCenter ? messageIds.indexOf(requestedCenter) : -1;
    const centerIndex = requestedIndex >= 0 ? requestedIndex : Math.max(0, messageIds.length - 1);
    const startIndex = Math.max(0, centerIndex - MARKERS_EACH_SIDE);
    return {
      centerMessageId: messageIds[centerIndex],
      messageIds: messageIds.slice(
        startIndex,
        Math.min(messageIds.length, centerIndex + MARKERS_EACH_SIDE + 1),
      ),
      startIndex,
    };
  }, [activeMessageId, messageIds, windowCenterMessageId]);

  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail || !markerWindow.centerMessageId) return;
    const index = markerWindow.messageIds.indexOf(markerWindow.centerMessageId);
    rail.scrollTop = index * MARKER_ROW_HEIGHT - (rail.clientHeight - MARKER_ROW_HEIGHT) / 2;
  }, [markerWindow]);

  if (messageIds.length === 0) return null;

  return (
    <nav
      ref={railRef}
      aria-label="User messages"
      className="my-auto w-7 overflow-hidden text-border"
      style={{
        height: `min(${markerWindow.messageIds.length * MARKER_ROW_HEIGHT}px, calc(100% - 2rem))`,
      }}
    >
      <div
        className="grid w-7 items-center"
        style={{
          gridTemplateRows: `repeat(${markerWindow.messageIds.length}, ${MARKER_ROW_HEIGHT}px)`,
        }}
      >
        {markerWindow.messageIds.map((messageId, index) => {
          const selected = messageId === activeMessageId;
          const targeted = messageId === navigation?.targetMessageId;
          const failed = targeted && Boolean(navigation.error);
          const ordinal = markerWindow.startIndex + index + 1;
          const label = `${failed ? "Retry" : "Go to"} user message ${ordinal} of ${messageIds.length}`;
          return (
            <button
              key={messageId}
              type="button"
              aria-label={label}
              aria-current={selected ? "true" : undefined}
              title={label}
              onClick={() => onSelect(messageId)}
              className={cn(
                "user-message-marker flex h-full min-h-0 w-7 items-center justify-end overflow-hidden transition-colors focus-visible:outline-none",
                failed
                  ? "text-status-crashed"
                  : selected
                    ? "text-text"
                    : targeted
                      ? "text-text-muted"
                      : "hover:text-text-muted focus-visible:text-text-muted",
              )}
            >
              <span
                className="user-message-marker-line block h-0.5 shrink-0 rounded-full bg-current transition-[width] duration-150 ease-out motion-reduce:transition-none"
                aria-hidden="true"
              />
            </button>
          );
        })}
      </div>
      {navigation?.error && (
        <span className="sr-only" role="status">
          {navigation.error}
        </span>
      )}
    </nav>
  );
});

export const StreamsMessageList = memo(function StreamsMessageList({
  piSessionId,
  rows,
  userMessageIndex,
  activeFindRowIndex,
  onPruneRequested,
  onForkRequested,
  isSessionBusy = false,
  onLoadPrevious,
  hasPreviousPage,
  isFetchingPreviousPage,
  ref,
}: StreamsMessageListProps) {
  useWhyDidYouRender("StreamsMessageList", { rows, isSessionBusy, activeFindRowIndex });
  const streamingRowKey = `${STREAMING_ROW_KEY}:${rows.at(-1)?.key ?? "empty"}`;
  const getItemKey = useCallback(
    (index: number) => (index === rows.length ? streamingRowKey : rows[index]!.key),
    [rows, streamingRowKey],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const didFinishInitialFillRef = useRef(false);
  const alignedMarkerRef = useRef<string>(undefined);
  const pendingScrollToEndRef = useRef(false);
  const viewportUserMessageIdRef = useRef<string>(undefined);
  const [markerNavigation, setMarkerNavigation] = useState<MarkerNavigation>();
  const [markerWindowMessageId, setMarkerWindowMessageId] = useState<string>();
  const [viewportUserMessageId, setViewportUserMessageId] = useState<string>();
  const selectUserMessage = useCallback((targetMessageId: string) => {
    alignedMarkerRef.current = undefined;
    setMarkerWindowMessageId(targetMessageId);
    setMarkerNavigation({
      targetMessageId,
      paddingEnd: Math.max(scrollRef.current?.clientHeight ?? 0, 16),
    });
  }, []);
  const loadPreviousPageWithoutNavigation = useCallback(() => {
    void onLoadPrevious().catch(() => {
      didFinishInitialFillRef.current = true;
    });
  }, [onLoadPrevious]);
  const navigationPaddingEnd =
    markerNavigation && !markerNavigation.error ? markerNavigation.paddingEnd : 16;
  const rangeExtractor = useCallback(
    (range: Parameters<typeof defaultRangeExtractor>[0]) => {
      const indexes = defaultRangeExtractor(range);
      return activeFindRowIndex === undefined || indexes.includes(activeFindRowIndex)
        ? indexes
        : [...indexes, activeFindRowIndex].sort((a, b) => a - b);
    },
    [activeFindRowIndex],
  );

  const virtualizer = useVirtualizer({
    count: rows.length + 1,
    getScrollElement: () => scrollRef.current, // owned here: ancestor refs attach too late
    getItemKey,
    estimateSize: (index) => (index === rows.length ? 0 : ESTIMATED_ROW_HEIGHT),
    overscan: VIRTUALIZER_OVERSCAN, // scroll-memory: initialOffset+cache go here
    rangeExtractor,
    paddingStart: 16,
    paddingEnd: navigationPaddingEnd,
    anchorTo: "end",
    followOnAppend: !markerNavigation || Boolean(markerNavigation.error),
    scrollEndThreshold: 120,
    directDomUpdates: true,
    onChange: (instance, sync) => {
      const virtualItems = instance.getVirtualItems();
      const scrollOffset = instance.scrollOffset ?? 0;
      const firstVisibleRowIndex = virtualItems.find(
        (item) => item.index < rows.length && item.end > scrollOffset,
      )?.index;
      if (firstVisibleRowIndex !== undefined) {
        let messageId: string | undefined;
        let nearestDistance = Number.POSITIVE_INFINITY;
        const trackedStartIndex = Math.max(
          (instance.range?.startIndex ?? firstVisibleRowIndex) - VIRTUALIZER_OVERSCAN,
          0,
        );
        const trackedEndIndex = Math.min(
          (instance.range?.endIndex ?? firstVisibleRowIndex) + VIRTUALIZER_OVERSCAN,
          rows.length - 1,
        );
        for (const item of virtualItems) {
          if (item.index < trackedStartIndex || item.index > trackedEndIndex) continue;
          const message = rows[item.index]?.message;
          if (message?.role !== "user") continue;
          const distance = Math.abs(item.start - scrollOffset);
          if (distance >= nearestDistance) continue;
          messageId = message.id;
          nearestDistance = distance;
        }
        messageId ??= userMessageForRow(rows, userMessageIndex, firstVisibleRowIndex);
        if (viewportUserMessageIdRef.current !== messageId) {
          viewportUserMessageIdRef.current = messageId;
          setMarkerWindowMessageId(messageId);
          setViewportUserMessageId(messageId);
        }
      }

      if (
        markerNavigation ||
        !didFinishInitialFillRef.current ||
        !sync ||
        instance.scrollDirection !== "backward"
      ) {
        return; // user scroll only: offset lags our writes
      }
      const firstRenderedIndex = virtualItems[0]?.index;
      if (
        firstRenderedIndex !== undefined &&
        firstRenderedIndex <= LOAD_PREVIOUS_ROW_THRESHOLD &&
        hasPreviousPage &&
        !isFetchingPreviousPage
      ) {
        loadPreviousPageWithoutNavigation();
      }
    },
  });

  useLayoutEffect(function rearmInitialFillAfterRouteReveal() {
    didFinishInitialFillRef.current = false; // Suspense replay wipes scrollTop: re-pin
  }, []); // scroll-memory: skip re-arm + snapshot save here

  useLayoutEffect(function pinToEndAndFillInitialViewport() {
    if (
      markerNavigation ||
      didFinishInitialFillRef.current ||
      virtualizer.getVirtualItems().length === 0
    ) {
      return;
    }

    virtualizer.scrollToEnd(); // post-commit: measured geometry, no estimates

    const viewportHeight = scrollRef.current?.clientHeight ?? 0;
    if (virtualizer.getTotalSize() > viewportHeight || !hasPreviousPage) {
      didFinishInitialFillRef.current = true;
    } else if (!isFetchingPreviousPage) {
      loadPreviousPageWithoutNavigation();
    }
  }); // no deps: re-pins across each fill prepend

  useLayoutEffect(() => {
    if (activeFindRowIndex === undefined) return;
    virtualizer.scrollToIndex(activeFindRowIndex, { align: "center", behavior: "auto" });
  }, [activeFindRowIndex, virtualizer]);

  useLayoutEffect(() => {
    if (!markerNavigation || markerNavigation.error) return;
    const rowIndex = rows.findIndex((row) => row.message?.id === markerNavigation.targetMessageId);
    if (rowIndex < 0) {
      alignedMarkerRef.current = undefined;
      return;
    }
    if (alignedMarkerRef.current === markerNavigation.targetMessageId) return;

    virtualizer.scrollToIndex(rowIndex, { align: "start", behavior: "auto" });
    alignedMarkerRef.current = markerNavigation.targetMessageId;
  }, [markerNavigation, rows, virtualizer]);

  useEffect(() => {
    if (!markerNavigation) return;
    const { targetMessageId } = markerNavigation;
    if (!userMessageIndex.includes(targetMessageId)) {
      setMarkerNavigation(undefined);
      return;
    }
    if (markerNavigation.error) return;
    if (rows.some((row) => row.message?.id === targetMessageId)) return;
    if (!hasPreviousPage) {
      setMarkerNavigation({
        ...markerNavigation,
        error: "This user message is no longer available in the active history.",
      });
      return;
    }

    void onLoadPrevious().catch(() => {
      setMarkerNavigation((current) =>
        current?.targetMessageId === targetMessageId
          ? {
              ...current,
              error: "Could not load this user message. Select its marker to retry.",
            }
          : current,
      );
    });
  }, [hasPreviousPage, markerNavigation, onLoadPrevious, rows, userMessageIndex]);

  useLayoutEffect(() => {
    if (!pendingScrollToEndRef.current || markerNavigation) return;
    pendingScrollToEndRef.current = false;
    virtualizer.scrollToEnd();
  }, [markerNavigation, virtualizer]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToEnd() {
        alignedMarkerRef.current = undefined;
        if (!markerNavigation) {
          virtualizer.scrollToEnd();
          return;
        }
        pendingScrollToEndRef.current = true;
        setMarkerNavigation(undefined);
      },
      navigateToLatestUserMessage() {
        const messageId = userMessageIndex.at(-1);
        if (!messageId) return false;
        selectUserMessage(messageId);
        return true;
      },
    }),
    [markerNavigation, selectUserMessage, userMessageIndex, virtualizer],
  );

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_1.75rem] gap-2">
      <div
        ref={scrollRef}
        data-scroll-container="main"
        className="h-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto px-6 [scrollbar-gutter:stable]"
      >
        <div className="relative w-full" style={{ minHeight: "2rem" }}>
          <div
            ref={virtualizer.containerRef}
            style={{
              position: "relative",
              width: "100%",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const row = rows[virtualItem.index];
              const active = virtualItem.index === activeFindRowIndex;
              return (
                <div
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  aria-current={active ? "true" : undefined}
                  ref={virtualizer.measureElement}
                  className={cn(
                    active && "rounded-lg bg-background-selected ring-1 ring-border-pop",
                  )}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    display: "flex",
                    flexDirection: "column",
                    width: "100%",
                  }}
                >
                  {row ? (
                    <ChatMessageRow
                      row={row}
                      piSessionId={piSessionId}
                      isSessionBusy={isSessionBusy}
                      onPrune={onPruneRequested}
                      onFork={onForkRequested}
                    />
                  ) : (
                    <StreamingAssistantRow piSessionId={piSessionId} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <UserMessageMarkers
        messageIds={userMessageIndex}
        activeMessageId={viewportUserMessageId}
        windowCenterMessageId={markerWindowMessageId}
        navigation={markerNavigation}
        onSelect={selectUserMessage}
      />
    </div>
  );
});
