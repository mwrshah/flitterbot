import { useSyncExternalStore } from "react";
import type { ConnectionState } from "~/lib/types";
import type { AutonomaWsClient } from "~/lib/ws";

type Listener = () => void;

export type WsConnectionStore = {
  getSnapshot: () => ConnectionState;
  getServerSnapshot: () => ConnectionState;
  subscribe: (listener: Listener) => () => void;
  start: () => () => void;
};

export function createWsConnectionStore(wsClient: AutonomaWsClient): WsConnectionStore {
  let state: ConnectionState = "connecting";
  let started = false;
  let unsubscribeConnection: (() => void) | null = null;
  const listeners = new Set<Listener>();

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const setState = (next: ConnectionState) => {
    if (state === next) return;
    state = next;
    emit();
  };

  return {
    getSnapshot: () => state,
    getServerSnapshot: () => "connecting",
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: () => {
      if (started) return () => {};

      started = true;
      unsubscribeConnection = wsClient.subscribeConnection((next) => {
        setState(next);
      });

      setState(wsClient.connectionState === "disconnected" ? "connecting" : wsClient.connectionState);
      wsClient.connect();

      return () => {
        unsubscribeConnection?.();
        unsubscribeConnection = null;
        started = false;
        wsClient.disconnect();
        setState("connecting");
      };
    },
  };
}

export function useWsConnectionState(store: WsConnectionStore): ConnectionState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}
