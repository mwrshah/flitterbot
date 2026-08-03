import assert from "node:assert/strict";
import test from "node:test";
import type { AnyRouter } from "@tanstack/react-router";
import { streamingStore } from "../src/lib/streaming-store.ts";
import { setupWsRouteSubscriptions } from "../src/lib/ws-route-subscriptions.ts";
import type { FlitterbotWsClient } from "../src/lib/ws.ts";

test("switching stream routes clears the previous session's streaming deltas", () => {
  let onResolved = () => {};
  const routerState = {
    matches: [
      {
        staticData: { wsMode: "pi-session" },
        params: { piSessionId: "stream-a" },
      },
    ],
  };
  const router = {
    state: routerState,
    subscribe: (_event: string, callback: () => void) => {
      onResolved = callback;
      return () => {};
    },
  } as unknown as AnyRouter;
  const wsClient = {
    setSessionSubscription: () => {},
    clearSessionSubscription: () => {},
  } as unknown as FlitterbotWsClient;

  const streamASnapshots: Array<[string | null, string | null, boolean]> = [];
  const streamBSnapshots: Array<[string | null, string | null, boolean]> = [];
  const stop = setupWsRouteSubscriptions(router, wsClient);

  try {
    streamingStore.onStreamingDelta("stream-a", (text, thinking, active) =>
      streamASnapshots.push([text, thinking, active]),
    );
    streamingStore.appendTextDelta("stream-a", "message-a", "partial A");
    streamingStore.setThinkingStreaming("stream-a", true, "message-a");
    streamingStore.appendThinkingDelta("stream-a", "message-a", "partial thinking A");

    routerState.matches = [
      {
        staticData: { wsMode: "pi-session" },
        params: { piSessionId: "stream-b" },
      },
    ];
    onResolved();

    streamingStore.offStreamingDelta("stream-a");
    streamingStore.onStreamingDelta("stream-b", (text, thinking, active) =>
      streamBSnapshots.push([text, thinking, active]),
    );
    streamingStore.appendTextDelta("stream-b", "message-b", "only B");
    streamingStore.setThinkingStreaming("stream-b", true, "message-b");
    streamingStore.appendThinkingDelta("stream-b", "message-b", "only thinking B");

    assert.deepEqual(streamASnapshots.at(-1), [null, null, false]);
    assert.deepEqual(streamBSnapshots.at(-1), ["only B", "only thinking B", true]);
  } finally {
    stop();
    streamingStore.offStreamingDelta("stream-a");
    streamingStore.offStreamingDelta("stream-b");
    streamingStore.clearSession("stream-a");
    streamingStore.clearSession("stream-b");
  }
});
