import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import type { ControlSurfaceWebSocketServerEvent } from "../../src/contracts/websocket.ts";
import { historyQueryKey } from "../src/lib/conversation-history.ts";
import { setupWsQueryBridge } from "../src/lib/ws-query-bridge.ts";
import type { FlitterbotWsClient } from "../src/lib/ws.ts";

test("canonical WebSocket events extend loader history without a turn-end refetch", () => {
  const sessionId = "bridge-session";
  const queryClient = new QueryClient();
  queryClient.setQueryData(historyQueryKey(sessionId), {
    pages: [{ piSessionId: sessionId, sessionFile: null, items: [] }],
    pageParams: [undefined],
  });

  let receive: ((event: ControlSurfaceWebSocketServerEvent) => void) | undefined;
  let invalidations = 0;
  const wsClient = {
    connectionState: "connected",
    subscribe(listener: (event: ControlSurfaceWebSocketServerEvent) => void) {
      receive = listener;
      return () => {};
    },
    subscribeConnection() {
      return () => {};
    },
    pauseSessionSubscription() {},
    activeSubscriptionPiSessionId() {
      return sessionId;
    },
    setResumePosition() {},
    resumeSessionSubscription() {},
  } as unknown as FlitterbotWsClient;
  const cleanup = setupWsQueryBridge({
    queryClient,
    wsClient,
    router: {
      invalidate() {
        invalidations++;
        return Promise.resolve();
      },
    } as never,
  });

  try {
    receive?.({
      type: "message_end",
      piSessionId: sessionId,
      message: {
        id: "assistant-1",
        kind: "message",
        role: "assistant",
        content: "answer",
        createdAt: "2026-08-05T00:00:00.000Z",
      },
      position: { incarnation: "runtime", sequence: 1 },
    });
    receive?.({
      type: "turn_end",
      piSessionId: sessionId,
      timestamp: "2026-08-05T00:00:01.000Z",
      position: { incarnation: "runtime", sequence: 2 },
    });

    const data = queryClient.getQueryData<{
      pages: Array<{ items: Array<{ id: string }> }>;
    }>(historyQueryKey(sessionId));
    assert.deepEqual(data?.pages[0]?.items.map(({ id }) => id), ["assistant-1"]);
    assert.equal(invalidations, 0);
  } finally {
    cleanup();
  }
});
