import { type InfiniteData, type QueryClient, replaceEqualDeep } from "@tanstack/react-query";
import type {
  ControlSurfaceWebSocketServerEvent,
  ConversationEventPosition,
} from "../../../src/contracts/websocket.ts";
import { streamingPerf } from "./streaming-perf.ts";
import type {
  ChatTimelineItem,
  ChatTimelineMessage,
  ChatTimelineTool,
  StreamsHistoryResponse,
} from "./types";

export type ActiveToolState = {
  toolUseId: string;
  pending: boolean;
  partialResult?: unknown;
  isError?: boolean;
};

type StreamingState = {
  messageId: string;
  text: string;
  thinking: string;
  thinkingActive: boolean;
};

type ConversationSubscriber = {
  onStreaming(state: StreamingState | undefined): void;
  onTool(event: { type: "upsert"; state: ActiveToolState } | { type: "clear_all" }): void;
};

type PendingCanonical = {
  item: ChatTimelineItem;
  position?: ConversationEventPosition;
};

type ConversationSession = {
  streaming?: StreamingState;
  tools: Map<string, ActiveToolState>;
  pendingOptimistic: Map<string, ChatTimelineMessage>;
  pendingCanonical: Map<string, PendingCanonical>;
  subscriber?: ConversationSubscriber;
};

type EventLedger = {
  position: ConversationEventPosition;
  recovering: boolean;
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

function sessionFor(sessionId: string): ConversationSession {
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      tools: new Map(),
      pendingOptimistic: new Map(),
      pendingCanonical: new Map(),
    };
    sessions.set(sessionId, session);
  }
  return session;
}

function streamFor(session: ConversationSession, messageId: string): StreamingState {
  if (session.streaming?.messageId === messageId) return session.streaming;
  const streaming = { messageId, text: "", thinking: "", thinkingActive: false };
  session.streaming = streaming;
  return streaming;
}

function reduce(sessionId: string, action: ConversationAction): void {
  const session = sessionFor(sessionId);
  switch (action.type) {
    case "text_delta": {
      const streaming = streamFor(session, action.messageId);
      streaming.text += action.delta;
      session.subscriber?.onStreaming({ ...streaming });
      return;
    }
    case "thinking_start": {
      const streaming = streamFor(session, action.messageId);
      streaming.thinkingActive = true;
      session.subscriber?.onStreaming({ ...streaming });
      return;
    }
    case "thinking_delta": {
      const streaming = streamFor(session, action.messageId);
      streaming.thinking += action.delta;
      session.subscriber?.onStreaming({ ...streaming });
      return;
    }
    case "thinking_end": {
      if (session.streaming?.messageId !== action.messageId) return;
      session.streaming.thinkingActive = false;
      session.subscriber?.onStreaming({ ...session.streaming });
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
      session.subscriber?.onTool({ type: "upsert", state: { ...state } });
      return;
    }
    case "drop_tool":
      session.tools.delete(action.toolUseId);
      return;
    case "clear_streaming":
      session.streaming = undefined;
      session.subscriber?.onStreaming(undefined);
      return;
    case "clear":
      session.streaming = undefined;
      session.tools.clear();
      session.subscriber?.onStreaming(undefined);
      session.subscriber?.onTool({ type: "clear_all" });
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

  const session = sessions.get(sessionId);
  if (!session) return replaceEqualDeep(oldData, snapshotData);

  const snapshotIds = new Set(snapshot.pages.flatMap((page) => page.items.map((item) => item.id)));
  const watermark = snapshot.pages[snapshot.pages.length - 1]?.historyPosition;
  if (watermark) {
    const ledger = eventLedgers.get(sessionId);
    if (
      !ledger ||
      ledger.position.incarnation !== watermark.incarnation ||
      ledger.position.sequence < watermark.sequence
    ) {
      eventLedgers.set(sessionId, { position: { ...watermark }, recovering: false });
    }
  }

  for (const [id, pending] of session.pendingCanonical) {
    const coveredByWatermark =
      watermark &&
      pending.position &&
      (pending.position.incarnation !== watermark.incarnation ||
        pending.position.sequence <= watermark.sequence);
    if (snapshotIds.has(id) || coveredByWatermark) session.pendingCanonical.delete(id);
  }
  for (const id of snapshotIds) session.pendingOptimistic.delete(id);

  const overlays: ChatTimelineItem[] = [
    ...Array.from(session.pendingCanonical.values(), ({ item }) => item),
    ...session.pendingOptimistic.values(),
  ].filter((item) => !snapshotIds.has(item.id));
  if (!overlays.length) return replaceEqualDeep(oldData, snapshotData);

  const pages = [...snapshot.pages];
  const lastIndex = pages.length - 1;
  const lastPage = pages[lastIndex];
  if (!lastPage) return replaceEqualDeep(oldData, snapshotData);
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
      eventLedgers.set(sessionId, { position: { ...position }, recovering: false });
      return "accept";
    }
    if (previous.incarnation !== position.incarnation) {
      eventLedgers.set(sessionId, { position: previous, recovering: true });
      return "gap";
    }
    if (position.sequence <= previous.sequence) return "duplicate";
    if (position.sequence !== previous.sequence + 1) {
      if (ledger?.recovering) return "recovering";
      eventLedgers.set(sessionId, { position: previous, recovering: true });
      return "gap";
    }
    eventLedgers.set(sessionId, { position: { ...position }, recovering: false });
    return "accept";
  },

  reset(sessionId: string, position: ConversationEventPosition): void {
    const session = sessionFor(sessionId);
    eventLedgers.set(sessionId, { position: { ...position }, recovering: false });
    session.pendingCanonical.clear();
    reduce(sessionId, { type: "clear" });
  },

  historyRewritten(sessionId: string): void {
    sessions.get(sessionId)?.pendingCanonical.clear();
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
    const token = streamingPerf.beginDeltaToCallback();
    reduce(sessionId, { type: "text_delta", messageId, delta });
    streamingPerf.endDeltaToCallback(token);
  },
  thinkingStart(sessionId: string, messageId: string): void {
    reduce(sessionId, { type: "thinking_start", messageId });
  },
  thinkingDelta(sessionId: string, messageId: string, delta: string): void {
    const token = streamingPerf.beginDeltaToCallback();
    reduce(sessionId, { type: "thinking_delta", messageId, delta });
    streamingPerf.endDeltaToCallback(token);
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
  subscribe(sessionId: string, subscriber: ConversationSubscriber): () => void {
    const session = sessionFor(sessionId);
    if (session.subscriber && session.subscriber !== subscriber) {
      throw new Error(`Conversation ${sessionId} already has an imperative subscriber`);
    }
    session.subscriber = subscriber;
    if (session.streaming) subscriber.onStreaming({ ...session.streaming });
    for (const state of session.tools.values()) {
      subscriber.onTool({ type: "upsert", state: { ...state } });
    }
    return () => {
      const current = sessions.get(sessionId);
      if (!current || current.subscriber !== subscriber) return;
      current.subscriber = undefined;
      if (
        !current.streaming &&
        current.tools.size === 0 &&
        current.pendingCanonical.size === 0 &&
        current.pendingOptimistic.size === 0
      ) {
        sessions.delete(sessionId);
      }
    };
  },
};
