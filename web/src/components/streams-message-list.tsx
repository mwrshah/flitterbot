import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import {
  memo,
  type Ref,
  type RefObject,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { ChatMessageRow, StreamingAssistantRow } from "~/components/chat-message-row";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { buildConversationRows } from "~/lib/conversation-rows";
import type { ChatTimelineItem } from "~/lib/types";

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
  onLoadPrevious?: () => void;
  hasPrevious?: boolean;
  isLoadingPrevious?: boolean;
  viewportRef: RefObject<HTMLDivElement | null>;
  ref?: Ref<StreamsMessageListHandle>;
};

export const StreamsMessageList = memo(function StreamsMessageList({
  piSessionId,
  timeline,
  onPruneRequested,
  onForkRequested,
  isSessionBusy = false,
  onLoadPrevious,
  hasPrevious = false,
  isLoadingPrevious = false,
  viewportRef,
  ref,
}: StreamsMessageListProps) {
  useWhyDidYouRender("StreamsMessageList", { timeline, isSessionBusy });
  const rows = useMemo(() => buildConversationRows(timeline), [timeline]);
  const streamingRowKey = `${STREAMING_ROW_KEY}:${rows.at(-1)?.key ?? "empty"}`;
  const loadPreviousRef = useRef(onLoadPrevious);
  loadPreviousRef.current = onLoadPrevious;
  const canLoadPreviousRef = useRef(false);
  canLoadPreviousRef.current = hasPrevious && !isLoadingPrevious;
  const loadPreviousRequestedRef = useRef(false);
  const didInitialScrollRef = useRef(false);

  const loadPreviousIfNeeded = useCallback(
    (instance: Virtualizer<HTMLDivElement, HTMLDivElement>, reachedTop: boolean) => {
      const viewportHeight = viewportRef.current?.clientHeight ?? 0;
      const contentDoesNotFillViewport =
        viewportHeight > 0 && instance.getTotalSize() <= viewportHeight;

      if (
        didInitialScrollRef.current &&
        (contentDoesNotFillViewport || reachedTop) &&
        canLoadPreviousRef.current &&
        !loadPreviousRequestedRef.current
      ) {
        loadPreviousRequestedRef.current = true;
        loadPreviousRef.current?.();
      }
    },
    [viewportRef],
  );

  const onVirtualizerChange = useCallback(
    (instance: Virtualizer<HTMLDivElement, HTMLDivElement>, sync: boolean) => {
      const reachedTop =
        sync && instance.scrollDirection === "backward" && instance.scrollOffset === 0;
      loadPreviousIfNeeded(instance, reachedTop);
    },
    [loadPreviousIfNeeded],
  );

  const virtualizer = useVirtualizer({
    count: rows.length + 1,
    getScrollElement: () => viewportRef.current,
    getItemKey: (index) => (index === rows.length ? streamingRowKey : rows[index]!.key),
    estimateSize: (index) => (index === rows.length ? 0 : 120),
    overscan: 2,
    paddingStart: 16,
    paddingEnd: 16,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 120,
    useFlushSync: false,
    onChange: onVirtualizerChange,
  });

  useLayoutEffect(() => {
    if (isLoadingPrevious) return;
    loadPreviousRequestedRef.current = false;
    if (!rows.length) return;

    const frame = requestAnimationFrame(() => {
      if (!didInitialScrollRef.current) {
        didInitialScrollRef.current = true;
        virtualizer.scrollToEnd();
      }
      loadPreviousIfNeeded(virtualizer, false);
    });
    return () => cancelAnimationFrame(frame);
  }, [isLoadingPrevious, loadPreviousIfNeeded, rows.length, virtualizer]);

  useImperativeHandle(ref, () => ({
    scrollToEnd() {
      virtualizer.scrollToEnd();
    },
  }));

  return (
    <div className="relative w-full" style={{ minHeight: "2rem" }}>
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
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
                transform: `translate3d(0, ${virtualItem.start}px, 0)`,
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
    prev.hasPrevious === next.hasPrevious &&
    prev.isLoadingPrevious === next.isLoadingPrevious &&
    prev.viewportRef === next.viewportRef &&
    prev.onPruneRequested === next.onPruneRequested &&
    prev.onForkRequested === next.onForkRequested
  );
}
