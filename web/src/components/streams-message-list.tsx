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
import { cn } from "cn";
import {
  memo,
  type Ref,
  type RefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChatMessageRow, StreamingAssistantRow } from "@/components/chat-message-row";
import { Tooltip } from "@/components/common/tooltip";
import { useWhyDidYouRender } from "@/hooks/use-why-did-you-render";
import type { ConversationRow } from "@/lib/conversation-rows";
import { activeUserMessageIdForViewport } from "@/lib/user-message-markers";

const LOAD_PREVIOUS_ROW_THRESHOLD = 2;
const ESTIMATED_ROW_HEIGHT = 280;
const MARKERS_EACH_SIDE = 10;
const MARKER_ROW_HEIGHT = 24;
const STREAMING_ROW_KEY = "streaming";
const VIRTUALIZER_OVERSCAN = 2;

export type StreamsMessageListHandle = {
  scrollToEnd(): void;
  scrollToEndIfWithinViewport(ratio: number): void;
  navigateToLatestUserMessage(): void;
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
  bottomInset?: number;
  ref?: Ref<StreamsMessageListHandle>;
};

type MarkerNavigation = {
  targetMessageId: string;
  error?: string;
};

type UserMessageMarkersProps = {
  scrollViewportRef: RefObject<HTMLDivElement | null>;
  messageIds: string[];
  activeMessageId?: string;
  windowCenterMessageId?: string;
  navigation?: MarkerNavigation;
  onSelect: (messageId: string) => void;
  onScrollToEnd: () => void;
};

function MarkerOverflowCount({
  count,
  direction,
}: {
  count: number;
  direction: "earlier" | "later";
}) {
  return (
    <span
      role="img"
      aria-label={`${count} ${direction} user messages not shown`}
      className="pointer-events-none flex h-full w-full select-none items-center justify-end pr-5 text-[9px] leading-none tabular-nums text-text-muted [@media(hover:hover)_and_(pointer:fine)]:pr-[194px]"
    >
      +{String(count).padStart(2, "0")}
    </span>
  );
}

const markerHitboxClassName =
  "pr-5 [@media(hover:hover)_and_(pointer:fine)]:pointer-events-none [@media(hover:hover)_and_(pointer:fine)]:pr-[194px] [@media(hover:hover)_and_(pointer:fine)]:after:absolute [@media(hover:hover)_and_(pointer:fine)]:after:top-1/2 [@media(hover:hover)_and_(pointer:fine)]:after:right-[194px] [@media(hover:hover)_and_(pointer:fine)]:after:w-[18px] [@media(hover:hover)_and_(pointer:fine)]:after:h-[9px] [@media(hover:hover)_and_(pointer:fine)]:after:-translate-y-1/2 [@media(hover:hover)_and_(pointer:fine)]:after:content-[''] [@media(hover:hover)_and_(pointer:fine)]:after:pointer-events-auto [@media(hover:hover)_and_(pointer:fine)]:group-hover/marker-rail:pointer-events-auto";

const UserMessageMarkers = memo(function UserMessageMarkers({
  scrollViewportRef,
  messageIds,
  activeMessageId,
  windowCenterMessageId,
  navigation,
  onSelect,
  onScrollToEnd,
}: UserMessageMarkersProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const attachWheelForwarding = useCallback(
    (rail: HTMLElement | null) => {
      const viewport = scrollViewportRef.current;
      if (!rail || !viewport) return;
      const style = getComputedStyle(viewport);
      const lineHeight =
        Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2;
      const forwardWheel = (event: WheelEvent) => {
        if (event.ctrlKey || event.defaultPrevented) return;
        const unit = event.deltaMode === 1 ? lineHeight : 1;
        event.preventDefault(); // Sibling scroller cannot receive native wheel chaining.
        viewport.scrollBy({
          left: event.deltaX * (event.deltaMode === 2 ? viewport.clientWidth : unit),
          top: event.deltaY * (event.deltaMode === 2 ? viewport.clientHeight : unit),
          behavior: "instant",
        });
      };
      rail.addEventListener("wheel", forwardWheel, { passive: false });
      return () => rail.removeEventListener("wheel", forwardWheel);
    },
    [scrollViewportRef],
  );
  const markerWindow = useMemo(() => {
    const requestedCenter = windowCenterMessageId ?? activeMessageId ?? messageIds.at(-1);
    const requestedIndex = requestedCenter ? messageIds.indexOf(requestedCenter) : -1;
    const centerIndex = requestedIndex >= 0 ? requestedIndex : Math.max(0, messageIds.length - 1);
    const windowSize = Math.min(messageIds.length, MARKERS_EACH_SIDE * 2 + 1);
    const windowStart = Math.min(
      Math.max(0, centerIndex - MARKERS_EACH_SIDE),
      messageIds.length - windowSize,
    );
    const windowEnd = windowStart + windowSize;
    const startIndex = windowStart + Number(windowStart > 0);
    const endIndex = windowEnd - Number(windowEnd < messageIds.length);
    return {
      centerMessageId: messageIds[centerIndex],
      messageIds: messageIds.slice(startIndex, endIndex),
      startIndex,
      hiddenBefore: startIndex,
      hiddenAfter: messageIds.length - endIndex,
    };
  }, [activeMessageId, messageIds, windowCenterMessageId]);

  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail || !markerWindow.centerMessageId) return;
    const index =
      markerWindow.messageIds.indexOf(markerWindow.centerMessageId) +
      Number(markerWindow.hiddenBefore > 0);
    rail.scrollTop = index * MARKER_ROW_HEIGHT - (rail.clientHeight - MARKER_ROW_HEIGHT) / 2;
  }, [markerWindow]);

  if (messageIds.length === 0) return null;
  const markerRowCount =
    markerWindow.messageIds.length +
    Number(markerWindow.hiddenBefore > 0) +
    Number(markerWindow.hiddenAfter > 0);

  return (
    <nav
      ref={attachWheelForwarding}
      aria-label="User messages"
      className="user-message-marker-rail group/marker-rail absolute -right-2 top-1/2 z-[15] w-[72px] -translate-y-1/2 text-border [@media(hover:hover)_and_(pointer:fine)]:pointer-events-none [@media(hover:hover)_and_(pointer:fine)]:-right-[182px] [@media(hover:hover)_and_(pointer:fine)]:w-[420px] [@media(hover:hover)_and_(pointer:fine)]:hover:pointer-events-auto"
      style={{
        height: `min(${(markerRowCount + 1) * MARKER_ROW_HEIGHT}px, calc(100% - 2rem))`,
      }}
    >
      <div ref={railRef} className="h-[calc(100%-24px)] overflow-hidden">
        <div
          className="user-message-marker-grid grid w-full items-center"
          style={{
            gridTemplateRows: `repeat(${markerRowCount}, ${MARKER_ROW_HEIGHT}px)`,
          }}
        >
          {markerWindow.hiddenBefore > 0 && (
            <MarkerOverflowCount count={markerWindow.hiddenBefore} direction="earlier" />
          )}
          {markerWindow.messageIds.map((messageId, index) => {
            const selected = messageId === activeMessageId;
            const failed = messageId === navigation?.targetMessageId && Boolean(navigation.error);
            const ordinal = markerWindow.startIndex + index + 1;
            const label = `${failed ? "Retry" : "Go to"} user message ${ordinal} of ${messageIds.length}`;
            return (
              <Tooltip key={messageId} content={label} delay={0} side="left" sideOffset={-134}>
                <button
                  type="button"
                  aria-label={label}
                  aria-current={selected ? "true" : undefined}
                  onClick={() => onSelect(messageId)}
                  className={cn(
                    "user-message-marker relative flex h-full min-h-0 w-full items-center justify-end overflow-hidden transition-colors duration-[220ms] ease-in-out motion-reduce:transition-none focus-visible:outline-none",
                    markerHitboxClassName,
                    failed ? "text-status-crashed" : selected ? "text-text" : undefined,
                  )}
                >
                  <span
                    className="user-message-marker-line block shrink-0 bg-current transition-[width,height] duration-[220ms] ease-in-out motion-reduce:transition-none"
                    aria-hidden="true"
                  />
                </button>
              </Tooltip>
            );
          })}
          {markerWindow.hiddenAfter > 0 && (
            <MarkerOverflowCount count={markerWindow.hiddenAfter} direction="later" />
          )}
        </div>
      </div>
      <Tooltip content="Go to end of conversation" delay={0} side="left" sideOffset={-134}>
        <button
          type="button"
          aria-label="Go to end of conversation"
          onClick={onScrollToEnd}
          className={cn(
            "group user-message-marker user-message-end-marker absolute bottom-0 flex h-6 min-h-0 w-full items-center justify-end text-border focus-visible:outline-none",
            markerHitboxClassName,
          )}
        >
          <span
            className="user-message-marker-arrow relative left-px block origin-right scale-[0.9] shrink-0 bg-current transition-[width,height,left] duration-[220ms] ease-in-out group-hover:left-0.5 motion-reduce:transition-none"
            aria-hidden="true"
          />
        </button>
      </Tooltip>
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
  bottomInset = 0,
  ref,
}: StreamsMessageListProps) {
  useWhyDidYouRender("StreamsMessageList", {
    rows,
    isSessionBusy,
    activeFindRowIndex,
    bottomInset,
  });
  const streamingRowKey = `${STREAMING_ROW_KEY}:${rows.at(-1)?.key ?? "empty"}`;
  const getItemKey = useCallback(
    (index: number) => (index === rows.length ? streamingRowKey : rows[index]!.key),
    [rows, streamingRowKey],
  );
  const trailingPadding = bottomInset > 0 ? 4 + bottomInset : 12;
  const scrollRef = useRef<HTMLDivElement>(null);
  const didFinishInitialFillRef = useRef(false);
  const pendingScrollToEndRef = useRef(false);
  const wasAtEndRef = useRef(true);
  const previousBottomInsetRef = useRef(bottomInset);
  const viewportUserMessageIdRef = useRef<string>(undefined);
  const [markerNavigation, setMarkerNavigation] = useState<MarkerNavigation>();
  const [markerWindowMessageId, setMarkerWindowMessageId] = useState<string>();
  const [viewportUserMessageId, setViewportUserMessageId] = useState<string>();
  const selectUserMessage = useCallback((targetMessageId: string) => {
    setMarkerWindowMessageId(targetMessageId);
    setMarkerNavigation({ targetMessageId });
  }, []);
  const loadPreviousPageWithoutNavigation = useCallback(() => {
    void onLoadPrevious().catch(() => {
      didFinishInitialFillRef.current = true;
    });
  }, [onLoadPrevious]);
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
    paddingEnd: trailingPadding,
    scrollPaddingEnd: trailingPadding,
    anchorTo: "end",
    followOnAppend: !markerNavigation || Boolean(markerNavigation.error),
    scrollEndThreshold: 120,
    directDomUpdates: true,
    onChange: (instance, sync) => {
      wasAtEndRef.current = instance.isAtEnd();
      const virtualItems = instance.getVirtualItems();
      const scrollOffset = instance.scrollOffset ?? 0;
      const messageId = activeUserMessageIdForViewport(
        rows,
        userMessageIndex,
        virtualItems,
        scrollOffset,
        scrollOffset + Math.max(0, (instance.scrollRect?.height ?? 0) - bottomInset),
      );
      if (viewportUserMessageIdRef.current !== messageId) {
        viewportUserMessageIdRef.current = messageId;
        if (messageId) setMarkerWindowMessageId(messageId);
        setViewportUserMessageId(messageId);
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

  useLayoutEffect(() => {
    if (previousBottomInsetRef.current === bottomInset) return;
    previousBottomInsetRef.current = bottomInset;
    if (wasAtEndRef.current) virtualizer.scrollToEnd();
  }, [bottomInset, virtualizer]);

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
    if (rowIndex < 0) return;

    virtualizer.scrollToIndex(rowIndex, { align: "start", behavior: "auto" });
    setMarkerNavigation(undefined);
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

  const scrollToEnd = useCallback(() => {
    if (!markerNavigation) {
      virtualizer.scrollToEnd();
      return;
    }
    pendingScrollToEndRef.current = true;
    setMarkerNavigation(undefined);
  }, [markerNavigation, virtualizer]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToEnd,
      scrollToEndIfWithinViewport(ratio: number) {
        const scrollElement = scrollRef.current;
        if (!scrollElement) return;
        const distanceFromEnd =
          scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight;
        if (distanceFromEnd <= scrollElement.clientHeight * ratio) scrollToEnd();
      },
      navigateToLatestUserMessage() {
        const messageId = userMessageIndex.at(-1);
        if (!messageId) return;
        selectUserMessage(messageId);
      },
    }),
    [scrollToEnd, selectUserMessage, userMessageIndex, virtualizer],
  );

  return (
    <div className="relative h-full min-h-0">
      <div
        ref={scrollRef}
        data-scroll-container="main"
        className="h-full min-h-0 w-[calc(100%+1px)] overflow-x-hidden overflow-y-auto px-6 [scrollbar-gutter:stable]"
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
        scrollViewportRef={scrollRef}
        messageIds={userMessageIndex}
        activeMessageId={viewportUserMessageId}
        windowCenterMessageId={markerWindowMessageId}
        navigation={markerNavigation}
        onSelect={selectUserMessage}
        onScrollToEnd={scrollToEnd}
      />
    </div>
  );
});
