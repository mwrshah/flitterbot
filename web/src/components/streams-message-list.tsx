import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, type Ref, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";
import { ChatMessageRow, StreamingAssistantRow } from "~/components/chat-message-row";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { buildConversationRows } from "~/lib/conversation-rows";
import type { ChatTimelineItem } from "~/lib/types";

const LOAD_PREVIOUS_ROW_THRESHOLD = 2;
const ESTIMATED_ROW_HEIGHT = 280;
const STREAMING_ROW_KEY = "streaming";

export type StreamsMessageListHandle = {
  scrollToEnd(): void;
};

type StreamsMessageListProps = {
  piSessionId: string;
  timeline: ChatTimelineItem[];
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
  timeline,
  onPruneRequested,
  onForkRequested,
  isSessionBusy = false,
  onLoadPrevious,
  hasPreviousPage,
  isFetchingPreviousPage,
  ref,
}: StreamsMessageListProps) {
  useWhyDidYouRender("StreamsMessageList", { timeline, isSessionBusy });
  const rows = useMemo(() => buildConversationRows(timeline), [timeline]);
  const streamingRowKey = `${STREAMING_ROW_KEY}:${rows.at(-1)?.key ?? "empty"}`;
  const scrollRef = useRef<HTMLDivElement>(null);
  const didFinishInitialFillRef = useRef(false);

  const virtualizer = useVirtualizer({
    count: rows.length + 1,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => (index === rows.length ? streamingRowKey : rows[index]!.key),
    estimateSize: (index) => (index === rows.length ? 0 : ESTIMATED_ROW_HEIGHT),
    overscan: 2,
    paddingStart: 16,
    paddingEnd: 16,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 120,
    directDomUpdates: true,
    onChange: (instance, sync) => {
      if (!didFinishInitialFillRef.current || !sync || instance.scrollDirection !== "backward") {
        return;
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
    didFinishInitialFillRef.current = false;
  }, []);

  useLayoutEffect(function pinToEndAndFillInitialViewport() {
    if (didFinishInitialFillRef.current || virtualizer.getVirtualItems().length === 0) return;

    virtualizer.scrollToEnd();

    const viewportHeight = scrollRef.current?.clientHeight ?? 0;
    if (virtualizer.getTotalSize() > viewportHeight || !hasPreviousPage) {
      didFinishInitialFillRef.current = true;
    } else if (!isFetchingPreviousPage) {
      onLoadPrevious();
    }
  });

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
            return (
              <div
                key={virtualItem.key}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
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
    prev.timeline === next.timeline &&
    prev.isSessionBusy === next.isSessionBusy &&
    prev.onLoadPrevious === next.onLoadPrevious &&
    prev.hasPreviousPage === next.hasPreviousPage &&
    prev.isFetchingPreviousPage === next.isFetchingPreviousPage &&
    prev.onPruneRequested === next.onPruneRequested &&
    prev.onForkRequested === next.onForkRequested
  );
}
