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
import { memo, type Ref, useCallback, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { ChatMessageRow, StreamingAssistantRow } from "@/components/chat-message-row";
import { useWhyDidYouRender } from "@/hooks/use-why-did-you-render";
import type { ConversationRow } from "@/lib/conversation-rows";
import { cn } from "@/lib/utils";

const LOAD_PREVIOUS_ROW_THRESHOLD = 2;
const ESTIMATED_ROW_HEIGHT = 280;
const STREAMING_ROW_KEY = "streaming";

export type StreamsMessageListHandle = {
  scrollToEnd(): void;
};

type StreamsMessageListProps = {
  piSessionId: string;
  rows: ConversationRow[];
  findOpen?: boolean;
  activeFindRowIndex?: number;
  onPruneRequested?: (entryId: string) => void;
  onForkRequested?: (entryId: string) => void;
  isSessionBusy?: boolean;
  onLoadPrevious: () => void;
  hasPreviousPage: boolean;
  isFetchingPreviousPage: boolean;
  ref?: Ref<StreamsMessageListHandle>;
};

export const StreamsMessageList = memo(function StreamsMessageList({
  piSessionId,
  rows,
  findOpen = false,
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const didFinishInitialFillRef = useRef(false);
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
    getItemKey: (index) => (index === rows.length ? streamingRowKey : rows[index]!.key),
    estimateSize: (index) => (index === rows.length ? 0 : ESTIMATED_ROW_HEIGHT),
    overscan: 2, // scroll-memory: initialOffset+cache go here
    rangeExtractor,
    paddingStart: findOpen ? 64 : 16,
    paddingEnd: 16,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 120,
    directDomUpdates: true,
    onChange: (instance, sync) => {
      if (!didFinishInitialFillRef.current || !sync || instance.scrollDirection !== "backward") {
        return; // user scroll only: offset lags our writes
      }
      const firstVisibleIndex = instance.getVirtualItems()[0]?.index;
      if (
        firstVisibleIndex !== undefined &&
        firstVisibleIndex <= LOAD_PREVIOUS_ROW_THRESHOLD &&
        hasPreviousPage &&
        !isFetchingPreviousPage
      ) {
        onLoadPrevious();
      }
    },
  });

  useLayoutEffect(function rearmInitialFillAfterRouteReveal() {
    didFinishInitialFillRef.current = false; // Suspense replay wipes scrollTop: re-pin
  }, []); // scroll-memory: skip re-arm + snapshot save here

  useLayoutEffect(function pinToEndAndFillInitialViewport() {
    if (didFinishInitialFillRef.current || virtualizer.getVirtualItems().length === 0) return;

    virtualizer.scrollToEnd(); // post-commit: measured geometry, no estimates

    const viewportHeight = scrollRef.current?.clientHeight ?? 0;
    if (virtualizer.getTotalSize() > viewportHeight || !hasPreviousPage) {
      didFinishInitialFillRef.current = true;
    } else if (!isFetchingPreviousPage) {
      onLoadPrevious();
    }
  }); // no deps: re-pins across each fill prepend

  useLayoutEffect(() => {
    if (activeFindRowIndex === undefined) return;
    virtualizer.scrollToIndex(activeFindRowIndex, { align: "center", behavior: "auto" });
  }, [activeFindRowIndex, virtualizer]);

  useImperativeHandle(ref, () => ({
    scrollToEnd() {
      virtualizer.scrollToEnd();
    },
  }));

  return (
    <div ref={scrollRef} data-scroll-container="main" className="h-full overflow-auto px-6">
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
                className={cn(active && "rounded-lg bg-background-selected ring-1 ring-border-pop")}
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
  );
}, areStreamsMessageListPropsEqual);

function areStreamsMessageListPropsEqual(
  prev: StreamsMessageListProps,
  next: StreamsMessageListProps,
) {
  return (
    prev.piSessionId === next.piSessionId &&
    prev.rows === next.rows &&
    prev.findOpen === next.findOpen &&
    prev.activeFindRowIndex === next.activeFindRowIndex &&
    prev.isSessionBusy === next.isSessionBusy &&
    prev.onLoadPrevious === next.onLoadPrevious &&
    prev.hasPreviousPage === next.hasPreviousPage &&
    prev.isFetchingPreviousPage === next.isFetchingPreviousPage &&
    prev.onPruneRequested === next.onPruneRequested &&
    prev.onForkRequested === next.onForkRequested
  );
}
