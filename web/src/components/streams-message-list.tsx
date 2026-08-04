import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
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
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import type { ActiveToolState } from "~/lib/active-tool-store";
import { getAgentMessageRowKeys, STREAMING_MESSAGE_ROW_KEY } from "~/lib/agent-message-rows";
import { ensurePiWebUiReady, getPiWebUiInitError } from "~/lib/pi-web-ui-init";
import { streamingPerf } from "~/lib/streaming-perf";
import type { MessageList, MessageListVirtualState } from "~/pi-web-ui/chat-components";

const LOAD_PREVIOUS_ROW_THRESHOLD = 3;

const EMPTY_TOOLS: AgentTool[] = [];
const EMPTY_PENDING = new Set<string>();
type MessageListElement = HTMLElement & MessageList & { updateComplete: Promise<unknown> };

export type StreamsMessageListHandle = {
  updateStreaming(message: AssistantMessage, isThinkingStreaming: boolean): void;
  clearStreaming(): void;
  scrollToEnd(): void;
  setActiveTools(states: ActiveToolState[]): void;
  applyActiveToolState(state: ActiveToolState): void;
  clearActiveTools(): void;
};

type StreamsMessageListProps = {
  messages: AgentMessage[];
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
  messages,
  onPruneRequested,
  onForkRequested,
  isSessionBusy = false,
  onLoadPrevious,
  hasPrevious = false,
  isLoadingPrevious = false,
  viewportRef,
  ref,
}: StreamsMessageListProps) {
  useWhyDidYouRender("StreamsMessageList", { messages, isSessionBusy });
  const containerRef = useRef<HTMLDivElement>(null);
  const elementRef = useRef<MessageListElement | null>(null);
  const pendingActiveToolsRef = useRef<Map<string, ActiveToolState>>(new Map());
  const clearActiveToolsQueuedRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const rowKeys = useMemo(() => getAgentMessageRowKeys(messages), [messages]);
  const streamingRowKey = `${STREAMING_MESSAGE_ROW_KEY}:${rowKeys[rowKeys.length - 1] ?? "empty"}`;
  const virtualizerRef = useRef<Virtualizer<HTMLDivElement, Element> | null>(null);
  const measureElement = useCallback((element: Element | undefined) => {
    virtualizerRef.current?.measureElement(element ?? null);
  }, []);
  const loadPreviousRef = useRef(onLoadPrevious);
  loadPreviousRef.current = onLoadPrevious;
  const canLoadPreviousRef = useRef(false);
  canLoadPreviousRef.current = hasPrevious && !isLoadingPrevious;
  const loadPreviousRequestedRef = useRef(false);
  const didInitialScrollRef = useRef(false);
  useEffect(() => {
    if (!isLoadingPrevious) loadPreviousRequestedRef.current = false;
  }, [isLoadingPrevious]);
  const virtualSnapshotRef = useRef<
    | {
        sourceItems: ReturnType<Virtualizer<HTMLDivElement, Element>["getVirtualItems"]>;
        state: MessageListVirtualState;
      }
    | undefined
  >(undefined);
  const publishVirtualState = useCallback(
    (instance: Virtualizer<HTMLDivElement, Element>) => {
      const sourceItems = instance.getVirtualItems();
      const totalSize = instance.getTotalSize();

      const firstVisibleIndex = sourceItems[0]?.index;
      const lastVisibleIndex = sourceItems[sourceItems.length - 1]?.index;
      const initialScrollWasComplete = didInitialScrollRef.current;
      if (
        !initialScrollWasComplete &&
        instance.options.count > 1 &&
        elementRef.current?.querySelector("[data-virtual-canvas]") &&
        firstVisibleIndex !== undefined &&
        (!canLoadPreviousRef.current || firstVisibleIndex > LOAD_PREVIOUS_ROW_THRESHOLD) &&
        lastVisibleIndex === instance.options.count - 1 &&
        instance.isAtEnd()
      ) {
        didInitialScrollRef.current = true;
        if (containerRef.current) containerRef.current.style.visibility = "visible";
      }
      if (
        initialScrollWasComplete &&
        firstVisibleIndex !== undefined &&
        firstVisibleIndex <= LOAD_PREVIOUS_ROW_THRESHOLD &&
        canLoadPreviousRef.current &&
        !loadPreviousRequestedRef.current
      ) {
        loadPreviousRequestedRef.current = true;
        loadPreviousRef.current?.();
      }

      const previous = virtualSnapshotRef.current;
      if (previous?.sourceItems === sourceItems && previous.state.totalSize === totalSize) {
        const element = elementRef.current;
        if (element && !element.virtualState) {
          element.virtualState = previous.state;
          element.updateVirtualGeometry(previous.state);
        }
        return;
      }

      const state: MessageListVirtualState = {
        items: sourceItems.map(({ index, key, start }) => ({ index, key, start })),
        totalSize,
        measureElement,
      };
      virtualSnapshotRef.current = { sourceItems, state };
      const element = elementRef.current;
      if (!element) return;

      const sameRange =
        previous?.state.items.length === state.items.length &&
        previous.state.items.every(
          (item, index) =>
            item.index === state.items[index]?.index && item.key === state.items[index]?.key,
        );
      if (sameRange && element.virtualState) {
        element.updateVirtualGeometry(state);
      } else {
        element.virtualState = state;
        element.updateVirtualGeometry(state);
      }
    },
    [measureElement],
  );
  const virtualizer = useVirtualizer({
    directDomUpdates: true, // Lit owns row geometry, not React
    onChange: publishVirtualState,
    count: rowKeys.length + 1,
    getScrollElement: () => viewportRef.current,
    getItemKey: (index) => (index === rowKeys.length ? streamingRowKey : rowKeys[index]!),
    estimateSize: (index) => (index === rowKeys.length ? 0 : 120),
    overscan: 2,
    paddingStart: 16,
    paddingEnd: 16,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 120,
    useFlushSync: false,
  });
  useLayoutEffect(() => {
    virtualizerRef.current = virtualizer;
    return () => {
      virtualizerRef.current = null;
    };
  }, [virtualizer]);
  const flushActiveTools = () => {
    const el = elementRef.current;
    if (!el) return;
    if (clearActiveToolsQueuedRef.current) {
      el.clearActiveTools();
      clearActiveToolsQueuedRef.current = false;
    }
    if (pendingActiveToolsRef.current.size > 0) {
      el.setActiveTools(Array.from(pendingActiveToolsRef.current.values()));
    }
  };

  useEffect(() => {
    let cancelled = false;

    ensurePiWebUiReady()
      .then(() => {
        if (cancelled) return;
        setReady(true);
      })
      .catch((initError) => {
        if (cancelled) return;
        setError(initError);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useLayoutEffect(() => {
    if (!ready) return;
    const container = containerRef.current;
    if (!container) return;

    if (!elementRef.current) {
      const el = document.createElement("message-list") as MessageListElement;
      el.style.display = "block";
      container.appendChild(el);
      elementRef.current = el;
    }

    const el = elementRef.current as MessageListElement & Record<string, unknown>;
    publishVirtualState(virtualizer);
    flushActiveTools();

    const renderToken = streamingPerf.beginCommittedLitRender();
    el.messages = messages;
    el.tools = EMPTY_TOOLS;
    el.pendingToolCalls = EMPTY_PENDING;
    el.isSessionBusy = isSessionBusy;
    void el.updateComplete.then(() => {
      streamingPerf.endCommittedLitRender(renderToken);
      if (elementRef.current !== el) return;
      flushActiveTools();
      if (rowKeys.length > 0 && !didInitialScrollRef.current) {
        virtualizer.scrollToEnd();
      }
    });
  }, [ready, messages, isSessionBusy, publishVirtualState, rowKeys.length, virtualizer]);

  useEffect(() => {
    return () => {
      elementRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const container = containerRef.current;
    if (!container) return;
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ entryId?: string }>).detail;
      const entryId = detail?.entryId;
      if (!entryId) return;
      onPruneRequested?.(entryId);
    };
    container.addEventListener("prune-message", handler);
    return () => {
      container.removeEventListener("prune-message", handler);
    };
  }, [ready, onPruneRequested]);

  useEffect(() => {
    if (!ready) return;
    const container = containerRef.current;
    if (!container) return;
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ entryId?: string }>).detail;
      const entryId = detail?.entryId;
      if (!entryId) return;
      onForkRequested?.(entryId);
    };
    container.addEventListener("fork-message", handler);
    return () => {
      container.removeEventListener("fork-message", handler);
    };
  }, [ready, onForkRequested]);

  useImperativeHandle(ref, () => ({
    updateStreaming(message: AssistantMessage, isThinkingStreaming: boolean) {
      elementRef.current?.updateStreaming(message, isThinkingStreaming);
    },
    clearStreaming() {
      elementRef.current?.clearStreaming();
    },
    scrollToEnd() {
      virtualizer.scrollToEnd();
    },
    setActiveTools(states: ActiveToolState[]) {
      pendingActiveToolsRef.current = new Map(states.map((state) => [state.toolUseId, state]));
      clearActiveToolsQueuedRef.current = false;
      elementRef.current?.setActiveTools(states);
    },
    applyActiveToolState(state: ActiveToolState) {
      pendingActiveToolsRef.current.set(state.toolUseId, state);
      clearActiveToolsQueuedRef.current = false;
      elementRef.current?.applyActiveToolState(state);
    },
    clearActiveTools() {
      pendingActiveToolsRef.current.clear();
      clearActiveToolsQueuedRef.current = true;
      if (elementRef.current) {
        elementRef.current.clearActiveTools();
        clearActiveToolsQueuedRef.current = false;
      }
    },
  }));

  if (error) {
    const initDetails = getPiWebUiInitError();
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-4">
        <p className="text-xs font-medium text-status-crashed">
          Streams Web UI failed to initialize. Check the browser console.
        </p>
        {initDetails instanceof Error ? (
          <p className="text-xs text-status-crashed">{initDetails.message}</p>
        ) : null}
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <p className="text-xs text-text-muted">Loading chat UI…</p>
      </div>
    );
  }

  return <div ref={containerRef} style={{ minHeight: "2rem", visibility: "hidden" }} />;
}, areStreamsMessageListPropsEqual);

function areStreamsMessageListPropsEqual(
  prev: StreamsMessageListProps,
  next: StreamsMessageListProps,
) {
  return (
    prev.messages === next.messages &&
    prev.isSessionBusy === next.isSessionBusy &&
    prev.onLoadPrevious === next.onLoadPrevious &&
    prev.hasPrevious === next.hasPrevious &&
    prev.isLoadingPrevious === next.isLoadingPrevious &&
    prev.viewportRef === next.viewportRef &&
    prev.onPruneRequested === next.onPruneRequested &&
    prev.onForkRequested === next.onForkRequested
  );
}
