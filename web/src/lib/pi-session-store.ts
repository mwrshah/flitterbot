import { useSyncExternalStore } from "react";
import type { ConnectionState, DeliveryMode, ImageAttachment } from "./types";

type StatusPill = { id: string; label: string; variant?: "info" | "error" };

export type SessionAccum = {
  appendedItems: import("./types").ChatTimelineItem[];
  statusPills: StatusPill[];
};

export function emptyAccum(): SessionAccum {
  return { appendedItems: [], statusPills: [] };
}

/** Shared frozen sentinel so getSessionAccum returns a stable ref for missing sessions */
const EMPTY_ACCUM: SessionAccum = Object.freeze({ appendedItems: [], statusPills: [] }) as SessionAccum;

type StreamingState = { text: string; messageId: string };
type StreamingCallback = (text: string | null, messageId: string | null) => void;

const activeStreams = new Map<string, StreamingState>();
const streamingCallbacks = new Map<string, StreamingCallback>();

type ThinkingStreamingState = { thinking: string; messageId: string };
type ThinkingStreamingCallback = (thinking: string | null, messageId: string | null) => void;

const activeThinkingStreams = new Map<string, ThinkingStreamingState>();
const thinkingStreamingCallbacks = new Map<string, ThinkingStreamingCallback>();

export type StreamingToolCall = { contentIndex: number; toolName: string; partialJson: string };
type ToolcallStreamingState = Map<number, StreamingToolCall>;
type ToolcallStreamingCallback = (toolCalls: StreamingToolCall[] | null) => void;

const activeToolcallStreams = new Map<string, ToolcallStreamingState>();
const toolcallStreamingCallbacks = new Map<string, ToolcallStreamingCallback>();

export type PiSessionStore = {
  getSessionAccum: (sessionId: string) => SessionAccum;
  updateSession: (sessionId: string, updater: (s: SessionAccum) => SessionAccum) => void;
  clearSession: (sessionId: string) => void;
  addPill: (sessionId: string, pill: StatusPill) => void;
  removePill: (sessionId: string, id: string) => void;
  /** Returns all appended items from all sessions, sorted by createdAt. */
  getAllAppendedItems: () => import("./types").ChatTimelineItem[];
  getSendMessage: () => (
    text: string,
    deliveryMode: DeliveryMode,
    images?: ImageAttachment[],
    targetSessionId?: string,
  ) => Promise<void>;
  setSendMessage: (fn: PiSessionStore["getSendMessage"]) => void;
  getConnectionState: () => ConnectionState;
  setConnectionState: (state: ConnectionState) => void;
  subscribe: (fn: () => void) => () => void;
  getSnapshot: () => PiSessionSnapshot;
  appendStreamingDelta: (sessionId: string, messageId: string, delta: string) => void;
  getStreamingState: (sessionId: string) => StreamingState | null;
  clearStreamingState: (sessionId: string) => void;
  onStreamingDelta: (sessionId: string, callback: StreamingCallback) => void;
  offStreamingDelta: (sessionId: string) => void;
  appendStreamingThinkingDelta: (sessionId: string, messageId: string, delta: string) => void;
  getStreamingThinkingState: (sessionId: string) => ThinkingStreamingState | null;
  clearStreamingThinkingState: (sessionId: string) => void;
  onStreamingThinkingDelta: (sessionId: string, callback: ThinkingStreamingCallback) => void;
  offStreamingThinkingDelta: (sessionId: string) => void;
  startStreamingToolCall: (sessionId: string, contentIndex: number, toolName: string) => void;
  appendStreamingToolCallDelta: (sessionId: string, contentIndex: number, delta: string) => void;
  getStreamingToolCalls: (sessionId: string) => StreamingToolCall[];
  clearStreamingToolCalls: (sessionId: string) => void;
  onStreamingToolCall: (sessionId: string, callback: ToolcallStreamingCallback) => void;
  offStreamingToolCall: (sessionId: string) => void;
};

export type PiSessionSnapshot = {
  sessions: Map<string, SessionAccum>;
  connectionState: ConnectionState;
};

export function createPiSessionStore(): PiSessionStore {
  let sessions = new Map<string, SessionAccum>();
  let connectionState: ConnectionState = "disconnected";
  let sendMessageFn: PiSessionStore["getSendMessage"] = () => async () => {};
  /** Stable wrapper — identity never changes, delegates to current sendMessageFn */
  const stableSendMessage: ReturnType<PiSessionStore["getSendMessage"]> = (
    text, deliveryMode, images, targetSessionId,
  ) => {
    const fn = sendMessageFn();
    return fn(text, deliveryMode, images, targetSessionId);
  };
  const listeners = new Set<() => void>();
  /** Frozen sessions snapshot — only replaced when sessions actually change */
  let sessionsSnapshot: Map<string, SessionAccum> = new Map(sessions);
  let snapshot: PiSessionSnapshot = { sessions: sessionsSnapshot, connectionState };

  function notify({ sessionsChanged = false } = {}) {
    if (sessionsChanged) {
      sessionsSnapshot = new Map(sessions);
    }
    snapshot = { sessions: sessionsSnapshot, connectionState };
    for (const fn of listeners) fn();
  }

  function getSessionAccum(sessionId: string): SessionAccum {
    return sessions.get(sessionId) ?? EMPTY_ACCUM;
  }

  function updateSession(sessionId: string, updater: (s: SessionAccum) => SessionAccum) {
    const current = sessions.get(sessionId) ?? emptyAccum();
    sessions = new Map(sessions);
    sessions.set(sessionId, updater(current));
    notify({ sessionsChanged: true });
  }

  function addPill(sessionId: string, pill: StatusPill) {
    updateSession(sessionId, (s) => ({
      ...s,
      statusPills: [...s.statusPills.filter((p) => p.id !== pill.id), pill].slice(-6),
    }));
  }

  function removePill(sessionId: string, id: string) {
    updateSession(sessionId, (s) => ({
      ...s,
      statusPills: s.statusPills.filter((p) => p.id !== id),
    }));
  }

  function getAllAppendedItems(): import("./types").ChatTimelineItem[] {
    const all: import("./types").ChatTimelineItem[] = [];
    for (const accum of sessions.values()) {
      all.push(...accum.appendedItems);
    }
    return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  function clearSession(sessionId: string) {
    if (sessions.has(sessionId)) {
      sessions = new Map(sessions);
      sessions.delete(sessionId);
      notify({ sessionsChanged: true });
    }
  }

  return {
    getSessionAccum,
    updateSession,
    clearSession,
    addPill,
    removePill,
    getAllAppendedItems,
    getSendMessage: () => stableSendMessage,
    setSendMessage: (fn) => {
      sendMessageFn = fn;
    },
    getConnectionState: () => connectionState,
    setConnectionState: (state) => {
      connectionState = state;
      notify();
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    getSnapshot: () => snapshot,
    appendStreamingDelta: (sessionId, messageId, delta) => {
      const existing = activeStreams.get(sessionId);
      if (existing) {
        existing.text += delta;
        existing.messageId = messageId;
      } else {
        activeStreams.set(sessionId, { text: delta, messageId });
      }
      const cb = streamingCallbacks.get(sessionId);
      if (cb) {
        const state = activeStreams.get(sessionId)!;
        cb(state.text, state.messageId);
      }
    },
    getStreamingState: (sessionId) => activeStreams.get(sessionId) ?? null,
    clearStreamingState: (sessionId) => {
      activeStreams.delete(sessionId);
      const cb = streamingCallbacks.get(sessionId);
      if (cb) cb(null, null);
    },
    onStreamingDelta: (sessionId, callback) => {
      streamingCallbacks.set(sessionId, callback);
    },
    offStreamingDelta: (sessionId) => {
      streamingCallbacks.delete(sessionId);
    },
    appendStreamingThinkingDelta: (sessionId, messageId, delta) => {
      const existing = activeThinkingStreams.get(sessionId);
      if (existing) {
        existing.thinking += delta;
        existing.messageId = messageId;
      } else {
        activeThinkingStreams.set(sessionId, { thinking: delta, messageId });
      }
      const cb = thinkingStreamingCallbacks.get(sessionId);
      if (cb) {
        const state = activeThinkingStreams.get(sessionId)!;
        cb(state.thinking, state.messageId);
      }
    },
    getStreamingThinkingState: (sessionId) => activeThinkingStreams.get(sessionId) ?? null,
    clearStreamingThinkingState: (sessionId) => {
      activeThinkingStreams.delete(sessionId);
      const cb = thinkingStreamingCallbacks.get(sessionId);
      if (cb) cb(null, null);
    },
    onStreamingThinkingDelta: (sessionId, callback) => {
      thinkingStreamingCallbacks.set(sessionId, callback);
    },
    offStreamingThinkingDelta: (sessionId) => {
      thinkingStreamingCallbacks.delete(sessionId);
    },
    startStreamingToolCall: (sessionId, contentIndex, toolName) => {
      let state = activeToolcallStreams.get(sessionId);
      if (!state) {
        state = new Map();
        activeToolcallStreams.set(sessionId, state);
      }
      state.set(contentIndex, { contentIndex, toolName, partialJson: "" });
      const cb = toolcallStreamingCallbacks.get(sessionId);
      if (cb) cb([...state.values()]);
    },
    appendStreamingToolCallDelta: (sessionId, contentIndex, delta) => {
      const state = activeToolcallStreams.get(sessionId);
      if (!state) return;
      const tc = state.get(contentIndex);
      if (tc) {
        tc.partialJson += delta;
        const cb = toolcallStreamingCallbacks.get(sessionId);
        if (cb) cb([...state.values()]);
      }
    },
    getStreamingToolCalls: (sessionId) => {
      const state = activeToolcallStreams.get(sessionId);
      return state ? [...state.values()] : [];
    },
    clearStreamingToolCalls: (sessionId) => {
      activeToolcallStreams.delete(sessionId);
      const cb = toolcallStreamingCallbacks.get(sessionId);
      if (cb) cb(null);
    },
    onStreamingToolCall: (sessionId, callback) => {
      toolcallStreamingCallbacks.set(sessionId, callback);
    },
    offStreamingToolCall: (sessionId) => {
      toolcallStreamingCallbacks.delete(sessionId);
    },
  };
}

/** Module-level singleton — initialized by PiLayoutRoute, consumed by child routes */
export let piSessionStore: PiSessionStore = createPiSessionStore();

export function resetPiSessionStore() {
  piSessionStore = createPiSessionStore();
}

/**
 * Subscribe to a single session's accum. Only re-renders when that session's
 * accum object identity changes (other sessions' updates are ignored).
 */
export function useSessionAccum(sessionId: string): SessionAccum {
  return useSyncExternalStore(
    piSessionStore.subscribe,
    () => piSessionStore.getSessionAccum(sessionId),
    () => piSessionStore.getSessionAccum(sessionId),
  );
}

/**
 * Subscribe to connectionState only. String primitive — equality is free.
 */
export function useConnectionState(): ConnectionState {
  return useSyncExternalStore(
    piSessionStore.subscribe,
    () => piSessionStore.getConnectionState(),
    () => piSessionStore.getConnectionState(),
  );
}

/**
 * Subscribe to the full sessions map. Re-renders on ANY session mutation.
 * Use sparingly — prefer useSessionAccum for single-session consumers.
 */
export function usePiSessions(): Map<string, SessionAccum> {
  return useSyncExternalStore(
    piSessionStore.subscribe,
    () => piSessionStore.getSnapshot().sessions,
    () => piSessionStore.getSnapshot().sessions,
  );
}

/**
 * Returns all appended items across all sessions, sorted by createdAt.
 * Re-renders on any session mutation (uses full snapshot).
 */
export function useAllAppendedItems(): import("./types").ChatTimelineItem[] {
  const sessions = usePiSessions();
  const items: import("./types").ChatTimelineItem[] = [];
  for (const accum of sessions.values()) {
    items.push(...accum.appendedItems);
  }
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
