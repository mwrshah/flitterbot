import { useCallback, useSyncExternalStore } from "react";
import type { AssistantBlockSnapshot } from "../../../src/contracts/websocket.ts";
import type { ChatTimelineMessageBlock, ChatTimelineTool } from "./types.ts";

export type ActiveToolState = Readonly<{
  toolUseId: string;
  pending: boolean;
  partialResult?: unknown;
  isError?: boolean;
}>;

export type ConversationStreamingBlock = Readonly<AssistantBlockSnapshot>;

export type ConversationStreamingState = Readonly<{
  messageId: string;
  blocks: ReadonlyMap<number, ConversationStreamingBlock>;
}>;

type ConversationListener = () => void;

type ConversationSession = {
  streaming?: ConversationStreamingState;
  publishedStreaming?: ConversationStreamingState;
  streamingFrame?: number;
  tools: Map<string, ActiveToolState>;
  streamingListeners: Set<ConversationListener>;
  toolListeners: Map<string, Set<ConversationListener>>;
};

type ConversationAction =
  | {
      type: "message_snapshot";
      messageId: string;
      blocks: AssistantBlockSnapshot[];
    }
  | {
      type: "block_set";
      messageId: string;
      contentIndex: number;
      block: ChatTimelineMessageBlock;
      tool?: ChatTimelineTool;
      active: boolean;
    }
  | {
      type: "block_delta";
      messageId: string;
      contentIndex: number;
      blockType: "text" | "thinking";
      delta: string;
    }
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
      streamingListeners: new Set(),
      toolListeners: new Map(),
    };
    sessions.set(sessionId, session);
  }
  return session;
}

function streamFor(session: ConversationSession, messageId: string): ConversationStreamingState {
  if (session.streaming?.messageId === messageId) return session.streaming;
  const streaming = { messageId, blocks: new Map<number, ConversationStreamingBlock>() };
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
    session.tools.size === 0
  ) {
    sessions.delete(sessionId);
  }
}

function reduce(sessionId: string, action: ConversationAction): void {
  const session = sessionFor(sessionId);
  switch (action.type) {
    case "message_snapshot": {
      session.streaming = {
        messageId: action.messageId,
        blocks: new Map(action.blocks.map((block, contentIndex) => [contentIndex, block])),
      };
      scheduleStreamingPublish(session);
      return;
    }
    case "block_set": {
      const streaming = streamFor(session, action.messageId);
      const blocks = new Map(streaming.blocks);
      blocks.set(action.contentIndex, {
        block: action.block,
        ...(action.tool ? { tool: action.tool } : {}),
        active: action.active,
      });
      session.streaming = { ...streaming, blocks };
      scheduleStreamingPublish(session);
      return;
    }
    case "block_delta": {
      const streaming = streamFor(session, action.messageId);
      const current = streaming.blocks.get(action.contentIndex);
      if (!current || current.block.type !== action.blockType) return;
      const block =
        current.block.type === "text"
          ? { ...current.block, text: current.block.text + action.delta }
          : { ...current.block, thinking: current.block.thinking + action.delta };
      const blocks = new Map(streaming.blocks);
      blocks.set(action.contentIndex, { ...current, block, active: true });
      session.streaming = { ...streaming, blocks };
      scheduleStreamingPublish(session);
      return;
    }
    case "tool": {
      const previous = session.tools.get(action.toolUseId);
      session.tools.set(action.toolUseId, {
        toolUseId: action.toolUseId,
        pending: action.pending,
        partialResult:
          action.partialResult === undefined ? previous?.partialResult : action.partialResult,
        isError: action.isError === undefined ? previous?.isError : action.isError,
      });
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

export const conversationState = {
  messageSnapshot(sessionId: string, messageId: string, blocks: AssistantBlockSnapshot[]): void {
    reduce(sessionId, { type: "message_snapshot", messageId, blocks });
  },
  blockSet(
    sessionId: string,
    action: Omit<Extract<ConversationAction, { type: "block_set" }>, "type">,
  ): void {
    reduce(sessionId, { type: "block_set", ...action });
  },
  blockDelta(
    sessionId: string,
    action: Omit<Extract<ConversationAction, { type: "block_delta" }>, "type">,
  ): void {
    reduce(sessionId, { type: "block_delta", ...action });
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
