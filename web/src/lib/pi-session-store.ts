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

type StreamingState = { text: string; messageId: string };
type StreamingCallback = (text: string | null, messageId: string | null) => void;

const activeStreams = new Map<string, StreamingState>();
const streamingCallbacks = new Map<string, StreamingCallback>();

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
};

export type PiSessionSnapshot = {
  sessions: Map<string, SessionAccum>;
  connectionState: ConnectionState;
};

export function createPiSessionStore(): PiSessionStore {
  let sessions = new Map<string, SessionAccum>();
  let connectionState: ConnectionState = "disconnected";
  let sendMessageFn: PiSessionStore["getSendMessage"] = () => async () => {};
  const listeners = new Set<() => void>();
  let snapshot: PiSessionSnapshot = { sessions, connectionState };

  function notify() {
    snapshot = { sessions: new Map(sessions), connectionState };
    for (const fn of listeners) fn();
  }

  function getSessionAccum(sessionId: string): SessionAccum {
    return sessions.get(sessionId) ?? emptyAccum();
  }

  function updateSession(sessionId: string, updater: (s: SessionAccum) => SessionAccum) {
    const current = sessions.get(sessionId) ?? emptyAccum();
    sessions = new Map(sessions);
    sessions.set(sessionId, updater(current));
    notify();
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
      notify();
    }
  }

  return {
    getSessionAccum,
    updateSession,
    clearSession,
    addPill,
    removePill,
    getAllAppendedItems,
    getSendMessage: () => sendMessageFn(),
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
  };
}

/** Module-level singleton — initialized by PiLayoutRoute, consumed by child routes */
export let piSessionStore: PiSessionStore = createPiSessionStore();

export function resetPiSessionStore() {
  piSessionStore = createPiSessionStore();
}

export function usePiSessionStore(): PiSessionSnapshot {
  return useSyncExternalStore(
    piSessionStore.subscribe,
    piSessionStore.getSnapshot,
    piSessionStore.getSnapshot,
  );
}
