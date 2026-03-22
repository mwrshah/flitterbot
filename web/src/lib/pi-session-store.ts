import { useSyncExternalStore } from "react";
import type { ConnectionState, DeliveryMode, ImageAttachment } from "./types";

type StatusPill = { id: string; label: string; variant?: "info" | "error" };

export type SessionAccum = {
  appendedItems: import("./types").ChatTimelineItem[];
  streamingText: string | null;
  statusPills: StatusPill[];
};

export function emptyAccum(): SessionAccum {
  return { appendedItems: [], streamingText: null, statusPills: [] };
}

export type PiSessionStore = {
  getSessionAccum: (sessionId: string) => SessionAccum;
  updateSession: (sessionId: string, updater: (s: SessionAccum) => SessionAccum) => void;
  addPill: (sessionId: string, pill: StatusPill) => void;
  removePill: (sessionId: string, id: string) => void;
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

  return {
    getSessionAccum,
    updateSession,
    addPill,
    removePill,
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
