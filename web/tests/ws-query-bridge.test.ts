import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import type { ControlSurfaceWebSocketServerEvent } from "../../src/contracts/websocket.ts";
import { conversationState } from "../src/lib/conversation-state.ts";
import { setupWsQueryBridge } from "../src/lib/ws-query-bridge.ts";
import type { FlitterbotWsClient } from "../src/lib/ws.ts";

const createdAt = "2026-08-05T00:00:00.000Z";

test("commits image-only live messages to the canonical timeline", () => {
  let receive: ((event: ControlSurfaceWebSocketServerEvent) => void) | undefined;
  const wsClient = {
    connectionState: "connected",
    subscribe(listener: (event: ControlSurfaceWebSocketServerEvent) => void) {
      receive = listener;
      return () => {};
    },
    subscribeConnection() {
      return () => {};
    },
    resumeSessionSubscription() {},
  } as unknown as FlitterbotWsClient;
  const queryClient = new QueryClient();
  const cleanup = setupWsQueryBridge({
    queryClient,
    wsClient,
    router: { invalidate() {} } as never,
  });

  try {
    receive?.({
      type: "message_end",
      piSessionId: "image-session",
      message: {
        id: "image-message",
        kind: "message",
        role: "user",
        content: "",
        images: [{ data: "base64-data", mimeType: "image/png" }],
        createdAt,
      },
      position: { incarnation: "current", sequence: 1 },
    });

    const history = queryClient.getQueryData<{
      pages: Array<{ items: Array<{ id: string; images?: unknown[] }> }>;
    }>(conversationState.historyQueryKey("image-session"));
    assert.equal(history?.pages[0]?.items[0]?.id, "image-message");
    assert.deepEqual(history?.pages[0]?.items[0]?.images, [
      { data: "base64-data", mimeType: "image/png" },
    ]);

    receive?.({
      type: "stream_surfaced",
      piSessionId: "image-session",
      streamId: "stream-1",
      message: {
        id: "surfaced-image",
        kind: "message",
        role: "user",
        content: "",
        images: [{ data: "surface-data", mimeType: "image/jpeg" }],
        createdAt,
      },
      position: { incarnation: "current", sequence: 2 },
    });
    const surface = queryClient.getQueryData<Array<{ id: string; images?: unknown[] }>>(
      conversationState.surfaceQueryKey,
    );
    assert.equal(surface?.[0]?.id, "surfaced-image");
    assert.deepEqual(surface?.[0]?.images, [
      { data: "surface-data", mimeType: "image/jpeg" },
    ]);
  } finally {
    cleanup();
  }
});
