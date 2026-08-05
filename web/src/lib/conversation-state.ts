import { type InfiniteData, type QueryClient, replaceEqualDeep } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import type {
  ControlSurfaceWebSocketServerEvent,
  ConversationEventPosition,
} from "../../../src/contracts/websocket.ts";
import type {
  ChatTimelineItem,
  ChatTimelineMessage,
  ChatTimelineTool,
  StreamsHistoryResponse,
} from "./types";

export type ActiveToolState = Readonly<{
  toolUseId: string;
  pending: boolean;
  partialResult?: unknown;
  isError?: boolean;
}>;

export type ConversationStreamingState = Readonly<{
  messageId: string;
  text: string;
  thinking: string;
  thinkingActive: boolean;
}>;

type ConversationListener = () => void;

type ConversationSession = {
  streaming?: ConversationStreamingState;
  publishedStreaming?: ConversationStreamingState;
  streamingFrame?: number;
  tools: Map<string, ActiveToolState>;
  pendingOptimistic: Map<string, ChatTimelineMessage>;
  pendingCanonical: Map<string, PendingCanonical>;
  streamingListeners: Set<ConversationListener>;
  toolListeners: Map<string, Set<ConversationListener>>;
};

type PendingCanonical = {
  item: ChatTimelineItem;
  position?: ConversationEventPosition;
};

type EventLedger = {
  position: ConversationEventPosition;
  recovering: boolean;
  supersededIncarnations: Set<string>;
};

type ConversationAction =
  | { type: "text_delta"; messageId: string; delta: string }
  | { type: "thinking_start"; messageId: string }
  | { type: "thinking_delta"; messageId: string; delta: string }
  | { type: "thinking_end"; messageId: string }
  | {
      type: "tool";
      toolUseId: string;
      pending: boolean;
      partialResult?: unknown;
      isError?: boolean;
    }
  | { type: "drop_tool"; toolUseId: string }
  | { type: "clear_streaming" }
  | { type: "clear" };

const sessions = new Map<string, ConversationSession>();
const eventLedgers = new Map<string, EventLedger>();
const snapshotGenerations = new Map<string, number>();
const snapshotTags = new WeakMap<object, { sessionId: string; generation: number }>();

function advanceSnapshotGeneration(sessionId: string): void {
  snapshotGenerations.set(sessionId, (snapshotGenerations.get(sessionId) ?? 0) + 1);
}

function sessionFor(sessionId: string): ConversationSession {
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      tools: new Map(),
      pendingOptimistic: new Map(),
      pendingCanonical: new Map(),
      streamingListeners: new Set(),
      toolListeners: new Map(),
    };
    sessions.set(sessionId, session);
  }
  return session;
}

function streamFor(session: ConversationSession, messageId: string): ConversationStreamingState {
  if (session.streaming?.messageId === messageId) return session.streaming;
  const streaming = { messageId, text: "", thinking: "", thinkingActive: false };
  session.streaming = streaming;
  return streaming;
}

function emitStreaming(session: ConversationSession): void {
  for (const listener of session.streamingListeners) listener();
}

function cancelStreamingPublish(session: ConversationSession): void {
  if (session.streamingFrame === undefined) return;
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(session.streamingFrame);
  session.streamingFrame = undefined;
}

function publishStreaming(session: ConversationSession): void {
  if (Object.is(session.publishedStreaming, session.streaming)) return;
  session.publishedStreaming = session.streaming;
  emitStreaming(session);
}

function scheduleStreamingPublish(session: ConversationSession): void {
  if (session.streamingListeners.size === 0) {
    cancelStreamingPublish(session);
    session.publishedStreaming = session.streaming;
    return;
  }
  if (session.publishedStreaming?.messageId !== session.streaming?.messageId) {
    cancelStreamingPublish(session);
    publishStreaming(session);
    return;
  }
  if (typeof requestAnimationFrame !== "function") {
    publishStreaming(session);
    return;
  }
  if (session.streamingFrame !== undefined) return;
  session.streamingFrame = requestAnimationFrame(() => {
    session.streamingFrame = undefined;
    publishStreaming(session);
  });
}

function emitTool(session: ConversationSession, toolUseId: string): void {
  for (const listener of session.toolListeners.get(toolUseId) ?? []) listener();
}

function deleteSessionIfEmpty(sessionId: string, session: ConversationSession): void {
  if (
    session.streamingListeners.size === 0 &&
    session.toolListeners.size === 0 &&
    !session.streaming &&
    session.tools.size === 0 &&
    session.pendingCanonical.size === 0 &&
    session.pendingOptimistic.size === 0
  ) {
    sessions.delete(sessionId);
  }
}

function reduce(sessionId: string, action: ConversationAction): void {
  const session = sessionFor(sessionId);
  switch (action.type) {
    case "text_delta": {
      const streaming = streamFor(session, action.messageId);
      session.streaming = { ...streaming, text: streaming.text + action.delta };
      scheduleStreamingPublish(session);
      return;
    }
    case "thinking_start": {
      const streaming = streamFor(session, action.messageId);
      if (streaming.thinkingActive) return;
      session.streaming = { ...streaming, thinkingActive: true };
      scheduleStreamingPublish(session);
      return;
    }
    case "thinking_delta": {
      const streaming = streamFor(session, action.messageId);
      session.streaming = { ...streaming, thinking: streaming.thinking + action.delta };
      scheduleStreamingPublish(session);
      return;
    }
    case "thinking_end": {
      if (session.streaming?.messageId !== action.messageId) return;
      if (!session.streaming.thinkingActive) return;
      session.streaming = { ...session.streaming, thinkingActive: false };
      scheduleStreamingPublish(session);
      return;
    }
    case "tool": {
      const previous = session.tools.get(action.toolUseId);
      const state: ActiveToolState = {
        toolUseId: action.toolUseId,
        pending: action.pending,
        partialResult:
          action.partialResult === undefined ? previous?.partialResult : action.partialResult,
        isError: action.isError === undefined ? previous?.isError : action.isError,
      };
      session.tools.set(action.toolUseId, state);
      emitTool(session, action.toolUseId);
      return;
    }
    case "drop_tool":
      if (session.tools.delete(action.toolUseId)) emitTool(session, action.toolUseId);
      return;
    case "clear_streaming":
      if (!session.streaming) return;
      cancelStreamingPublish(session);
      session.streaming = undefined;
      publishStreaming(session);
      return;
    case "clear": {
      const hadStreaming = Boolean(session.streaming);
      const toolUseIds = Array.from(session.tools.keys());
      if (!hadStreaming && toolUseIds.length === 0) return;
      cancelStreamingPublish(session);
      session.streaming = undefined;
      session.tools.clear();
      if (hadStreaming) publishStreaming(session);
      for (const toolUseId of toolUseIds) emitTool(session, toolUseId);
      return;
    }
  }
}

function historyQueryKey(sessionId: string | undefined) {
  return ["streams-history", sessionId ?? "default", "agent"] as const;
}

function updateTimeline(
  queryClient: QueryClient,
  sessionId: string,
  update: (items: ChatTimelineItem[]) => ChatTimelineItem[],
): void {
  queryClient.setQueryData<InfiniteData<StreamsHistoryResponse, string | undefined>>(
    historyQueryKey(sessionId),
    (old) => {
      if (!old?.pages.length) {
        const items = update([]);
        if (!items.length) return old;
        return {
          pages: [{ piSessionId: sessionId, sessionFile: null, items }],
          pageParams: [undefined],
        };
      }
      const lastIndex = old.pages.length - 1;
      const page = old.pages[lastIndex];
      if (!page) return old;
      const items = update(page.items);
      if (items === page.items) return old;
      const pages = [...old.pages];
      pages[lastIndex] = { ...page, items };
      return { pages, pageParams: old.pageParams };
    },
  );
}

function upsert(items: ChatTimelineItem[], item: ChatTimelineItem): ChatTimelineItem[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index < 0) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

function reconcileSnapshot(sessionId: string, oldData: unknown, snapshotData: unknown): unknown {
  const snapshot = snapshotData as
    | InfiniteData<StreamsHistoryResponse, string | undefined>
    | undefined;
  if (!snapshot?.pages.length) return replaceEqualDeep(oldData, snapshotData);

  const lastIndex = snapshot.pages.length - 1;
  const lastPage = snapshot.pages[lastIndex];
  if (!lastPage) return replaceEqualDeep(oldData, snapshotData);
  const oldSnapshot = oldData as
    | InfiniteData<StreamsHistoryResponse, string | undefined>
    | undefined;
  const oldPages = new Set(oldSnapshot?.pages);
  const generation = snapshotGenerations.get(sessionId) ?? 0;
  let lastPageIsNetworkSnapshot = false;
  for (const page of snapshot.pages) {
    if (oldPages.has(page)) continue;
    const tag = snapshotTags.get(page);
    if (!tag) continue;
    if (tag.sessionId !== sessionId || tag.generation !== generation) return oldData;
    if (page === lastPage) lastPageIsNetworkSnapshot = true;
  }

  const watermark = lastPage.historyPosition;
  const ledger = eventLedgers.get(sessionId);
  let acceptedNewIncarnation = false;
  if (
    lastPageIsNetworkSnapshot &&
    watermark &&
    ledger?.position.incarnation === watermark.incarnation &&
    watermark.sequence < ledger.position.sequence
  ) {
    return oldData;
  }
  if (watermark && ledger?.position.incarnation !== watermark.incarnation) {
    if (ledger?.supersededIncarnations.has(watermark.incarnation)) return oldData;
    acceptedNewIncarnation = Boolean(ledger);
    const supersededIncarnations = new Set(ledger?.supersededIncarnations);
    if (ledger) supersededIncarnations.add(ledger.position.incarnation);
    eventLedgers.set(sessionId, {
      position: { ...watermark },
      recovering: false,
      supersededIncarnations,
    });
  } else if (watermark && ledger && ledger.position.sequence < watermark.sequence) {
    eventLedgers.set(sessionId, {
      position: { ...watermark },
      recovering: false,
      supersededIncarnations: ledger.supersededIncarnations,
    });
  }

  const session = sessions.get(sessionId);
  if (!session) return replaceEqualDeep(oldData, snapshotData);

  const snapshotIds = new Set(snapshot.pages.flatMap((page) => page.items.map((item) => item.id)));
  const canSettlePending = lastPageIsNetworkSnapshot || (!oldData && Boolean(watermark));
  if (canSettlePending) {
    for (const [id, pending] of session.pendingCanonical) {
      const coveredByWatermark =
        watermark &&
        pending.position &&
        (acceptedNewIncarnation ||
          (pending.position.incarnation === watermark.incarnation &&
            pending.position.sequence <= watermark.sequence));
      if (snapshotIds.has(id) || coveredByWatermark) session.pendingCanonical.delete(id);
    }
    for (const id of snapshotIds) session.pendingOptimistic.delete(id);
  }

  const overlays: ChatTimelineItem[] = [
    ...Array.from(session.pendingCanonical.values(), ({ item }) => item),
    ...session.pendingOptimistic.values(),
  ].filter((item) => !snapshotIds.has(item.id));
  if (!overlays.length) return replaceEqualDeep(oldData, snapshotData);

  const pages = [...snapshot.pages];
  pages[lastIndex] = { ...lastPage, items: [...lastPage.items, ...overlays] };
  return replaceEqualDeep(oldData, { pages, pageParams: snapshot.pageParams });
}

export const conversationState = {
  historyQueryKey,
  surfaceQueryKey: ["surface-timeline"] as const,
  historyStaleTime: Number.POSITIVE_INFINITY,

  position(sessionId: string): ConversationEventPosition | undefined {
    const position = eventLedgers.get(sessionId)?.position;
    return position ? { ...position } : undefined;
  },

  observeEvent(
    sessionId: string,
    event: ControlSurfaceWebSocketServerEvent,
  ): "accept" | "duplicate" | "gap" | "recovering" {
    const position = event.position;
    if (!position) return "accept";
    const ledger = eventLedgers.get(sessionId);
    const previous = ledger?.position;
    if (!previous) {
      eventLedgers.set(sessionId, {
        position: { ...position },
        recovering: false,
        supersededIncarnations: new Set(),
      });
      return "accept";
    }
    if (previous.incarnation !== position.incarnation) {
      if (ledger.supersededIncarnations.has(position.incarnation)) return "duplicate";
      if (ledger.recovering) return "recovering";
      advanceSnapshotGeneration(sessionId);
      eventLedgers.set(sessionId, { ...ledger, position: previous, recovering: true });
      return "gap";
    }
    if (position.sequence <= previous.sequence) return "duplicate";
    if (position.sequence !== previous.sequence + 1) {
      if (ledger.recovering) return "recovering";
      advanceSnapshotGeneration(sessionId);
      eventLedgers.set(sessionId, { ...ledger, position: previous, recovering: true });
      return "gap";
    }
    eventLedgers.set(sessionId, { ...ledger, position: { ...position }, recovering: false });
    return "accept";
  },

  reset(sessionId: string, position: ConversationEventPosition): void {
    advanceSnapshotGeneration(sessionId);
    const session = sessionFor(sessionId);
    const previous = eventLedgers.get(sessionId);
    const supersededIncarnations = new Set(previous?.supersededIncarnations);
    if (previous && previous.position.incarnation !== position.incarnation) {
      supersededIncarnations.add(previous.position.incarnation);
    }
    eventLedgers.set(sessionId, {
      position: { ...position },
      recovering: false,
      supersededIncarnations,
    });
    session.pendingCanonical.clear();
    reduce(sessionId, { type: "clear" });
  },

  historyRewritten(sessionId: string): void {
    advanceSnapshotGeneration(sessionId);
    sessions.get(sessionId)?.pendingCanonical.clear();
  },

  snapshotGeneration(sessionId: string): number {
    return snapshotGenerations.get(sessionId) ?? 0;
  },

  tagSnapshot<T extends object>(sessionId: string, generation: number, snapshot: T): T {
    snapshotTags.set(snapshot, { sessionId, generation });
    return snapshot;
  },

  snapshotReconciler(sessionId: string) {
    return (oldData: unknown, snapshotData: unknown): unknown =>
      reconcileSnapshot(sessionId, oldData, snapshotData);
  },

  addOptimistic(queryClient: QueryClient, sessionId: string, message: ChatTimelineMessage): void {
    const session = sessionFor(sessionId);
    session.pendingOptimistic.set(message.id, message);
    updateTimeline(queryClient, sessionId, (items) => upsert(items, message));
  },

  removeOptimistic(queryClient: QueryClient, sessionId: string, messageId: string): void {
    const session = sessions.get(sessionId);
    if (!session?.pendingOptimistic.delete(messageId)) return;
    updateTimeline(queryClient, sessionId, (items) => {
      const next = items.filter(
        (item) =>
          item.id !== messageId || (item.kind !== "divider" && item.piEntryId !== undefined),
      );
      return next.length === items.length ? items : next;
    });
  },

  commitMessage(
    queryClient: QueryClient,
    sessionId: string,
    message: ChatTimelineMessage | undefined,
    optimisticId: string | undefined,
    tools: ChatTimelineTool[],
    position?: ConversationEventPosition,
  ): void {
    const session = sessionFor(sessionId);
    if (optimisticId) session.pendingOptimistic.delete(optimisticId);
    if (message) session.pendingCanonical.set(message.id, { item: message, position });
    for (const tool of tools) session.pendingCanonical.set(tool.id, { item: tool, position });

    updateTimeline(queryClient, sessionId, (items) => {
      let next = items;
      if (message) {
        if (optimisticId && optimisticId !== message.id) {
          next = next.filter((item) => item.id !== optimisticId);
        }
        next = upsert(next, message);
      }
      for (const tool of tools) next = upsert(next, tool);
      return next;
    });
  },

  appendLiveItem(
    queryClient: QueryClient,
    sessionId: string,
    item: ChatTimelineItem,
    position?: ConversationEventPosition,
  ): void {
    sessionFor(sessionId).pendingCanonical.set(item.id, { item, position });
    updateTimeline(queryClient, sessionId, (items) => upsert(items, item));
  },

  settleTurn(queryClient: QueryClient, sessionId: string): void {
    queryClient.invalidateQueries({ queryKey: historyQueryKey(sessionId) });
  },

  commitSurface(queryClient: QueryClient, message: ChatTimelineMessage): void {
    queryClient.setQueryData<ChatTimelineItem[]>(this.surfaceQueryKey, (old) =>
      upsert(old ?? [], message),
    );
  },

  textDelta(sessionId: string, messageId: string, delta: string): void {
    reduce(sessionId, { type: "text_delta", messageId, delta });
  },
  thinkingStart(sessionId: string, messageId: string): void {
    reduce(sessionId, { type: "thinking_start", messageId });
  },
  thinkingDelta(sessionId: string, messageId: string, delta: string): void {
    reduce(sessionId, { type: "thinking_delta", messageId, delta });
  },
  thinkingEnd(sessionId: string, messageId: string): void {
    reduce(sessionId, { type: "thinking_end", messageId });
  },
  tool(
    sessionId: string,
    action: Omit<Extract<ConversationAction, { type: "tool" }>, "type">,
  ): void {
    reduce(sessionId, { type: "tool", ...action });
  },
  dropTool(sessionId: string, toolUseId: string): void {
    reduce(sessionId, { type: "drop_tool", toolUseId });
  },
  finishMessage(sessionId: string): void {
    if (sessions.has(sessionId)) reduce(sessionId, { type: "clear_streaming" });
  },
  clear(sessionId: string): void {
    if (sessions.has(sessionId)) reduce(sessionId, { type: "clear" });
  },
  subscribeStreaming(sessionId: string, listener: ConversationListener): () => void {
    const session = sessionFor(sessionId);
    session.streamingListeners.add(listener);
    return () => {
      const current = sessions.get(sessionId);
      if (!current) return;
      current.streamingListeners.delete(listener);
      if (current.streamingListeners.size === 0) {
        cancelStreamingPublish(current);
        current.publishedStreaming = current.streaming;
      }
      deleteSessionIfEmpty(sessionId, current);
    };
  },

  subscribeTool(sessionId: string, toolUseId: string, listener: ConversationListener): () => void {
    const session = sessionFor(sessionId);
    const listeners = session.toolListeners.get(toolUseId) ?? new Set();
    listeners.add(listener);
    session.toolListeners.set(toolUseId, listeners);
    return () => {
      const current = sessions.get(sessionId);
      if (!current) return;
      const currentListeners = current.toolListeners.get(toolUseId);
      currentListeners?.delete(listener);
      if (currentListeners?.size === 0) current.toolListeners.delete(toolUseId);
      deleteSessionIfEmpty(sessionId, current);
    };
  },

  streamingSnapshot(sessionId: string): ConversationStreamingState | undefined {
    return sessions.get(sessionId)?.publishedStreaming;
  },

  toolSnapshot(sessionId: string, toolUseId: string): ActiveToolState | undefined {
    return sessions.get(sessionId)?.tools.get(toolUseId);
  },
};

export function useConversationStreaming(
  sessionId: string,
): ConversationStreamingState | undefined {
  const subscribe = useCallback(
    (listener: ConversationListener) => conversationState.subscribeStreaming(sessionId, listener),
    [sessionId],
  );
  const getSnapshot = useCallback(
    () => conversationState.streamingSnapshot(sessionId),
    [sessionId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useConversationToolState(
  sessionId: string,
  toolUseId: string,
): ActiveToolState | undefined {
  const subscribe = useCallback(
    (listener: ConversationListener) =>
      conversationState.subscribeTool(sessionId, toolUseId, listener),
    [sessionId, toolUseId],
  );
  const getSnapshot = useCallback(
    () => conversationState.toolSnapshot(sessionId, toolUseId),
    [sessionId, toolUseId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
