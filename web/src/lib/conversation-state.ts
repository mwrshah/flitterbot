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

type ConversationSession = {
  streaming?: StreamingState;
  tools: Map<string, ActiveToolState>;
  pendingOptimistic: Map<string, ChatTimelineMessage>;
  pendingCanonical: Map<string, ChatTimelineItem>;
  position?: ConversationEventPosition;
  recovering?: boolean;
  subscriber?: ConversationSubscriber;
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
  for (const id of snapshotIds) {
    session.pendingCanonical.delete(id);
    session.pendingOptimistic.delete(id);
  }

  const overlays: ChatTimelineItem[] = [
    ...session.pendingCanonical.values(),
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
    const position = sessions.get(sessionId)?.position;
    return position ? { ...position } : undefined;
  },

  observeEvent(
    sessionId: string,
    event: ControlSurfaceWebSocketServerEvent,
  ): "accept" | "duplicate" | "gap" | "recovering" {
    const position = event.position;
    if (!position) return "accept";
    const session = sessionFor(sessionId);
    const previous = session.position;
    if (!previous) {
      session.position = { ...position };
      return "accept";
    }
    if (previous.incarnation !== position.incarnation) {
      session.recovering = true;
      return "gap";
    }
    if (position.sequence <= previous.sequence) return "duplicate";
    if (position.sequence !== previous.sequence + 1) {
      if (session.recovering) return "recovering";
      session.recovering = true;
      return "gap";
    }
    session.position = { ...position };
    session.recovering = false;
    return "accept";
  },

  reset(sessionId: string, position: ConversationEventPosition): void {
    const session = sessionFor(sessionId);
    session.position = { ...position };
    session.recovering = false;
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
  ): void {
    const session = sessionFor(sessionId);
    if (optimisticId) session.pendingOptimistic.delete(optimisticId);
    if (message) session.pendingCanonical.set(message.id, message);
    for (const tool of tools) session.pendingCanonical.set(tool.id, tool);

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

  appendLiveItem(queryClient: QueryClient, sessionId: string, item: ChatTimelineItem): void {
    sessionFor(sessionId).pendingCanonical.set(item.id, item);
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
