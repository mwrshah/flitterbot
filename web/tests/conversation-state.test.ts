import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { conversationState } from "../src/lib/conversation-state.ts";

test("publishes stable streaming snapshots to multiple subscribers", () => {
  const sessionId = "test-streaming-subscribers";
  let firstCalls = 0;
  let secondCalls = 0;
  const unsubscribeFirst = conversationState.subscribeStreaming(sessionId, () => firstCalls++);
  const unsubscribeSecond = conversationState.subscribeStreaming(sessionId, () => secondCalls++);

  conversationState.textDelta(sessionId, "message-1", "hel");
  const firstSnapshot = conversationState.streamingSnapshot(sessionId);
  conversationState.textDelta(sessionId, "message-1", "lo");
  const secondSnapshot = conversationState.streamingSnapshot(sessionId);

  assert.deepEqual(secondSnapshot, {
    messageId: "message-1",
    text: "hello",
    thinking: "",
    thinkingActive: false,
  });
  assert.notEqual(firstSnapshot, secondSnapshot);
  assert.equal(firstCalls, 2);
  assert.equal(secondCalls, 2);

  unsubscribeFirst();
  conversationState.finishMessage(sessionId);
  assert.equal(firstCalls, 2);
  assert.equal(secondCalls, 3);
  assert.equal(conversationState.streamingSnapshot(sessionId), undefined);
  unsubscribeSecond();
});

test("coalesces streaming publications to one browser animation frame", () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  globalThis.requestAnimationFrame = (callback) => {
    const frame = nextFrame++;
    callbacks.set(frame, callback);
    return frame;
  };
  globalThis.cancelAnimationFrame = (frame) => callbacks.delete(frame);

  const sessionId = "test-streaming-frame-coalescing";
  let calls = 0;
  const unsubscribe = conversationState.subscribeStreaming(sessionId, () => calls++);
  try {
    conversationState.textDelta(sessionId, "message-1", "a");
    conversationState.textDelta(sessionId, "message-1", "b");
    conversationState.textDelta(sessionId, "message-1", "c");

    assert.equal(calls, 1);
    assert.equal(conversationState.streamingSnapshot(sessionId)?.text, "a");
    assert.equal(callbacks.size, 1);
    const [[frame, callback]] = callbacks;
    callbacks.delete(frame);
    callback(0);
    assert.equal(calls, 2);
    assert.equal(conversationState.streamingSnapshot(sessionId)?.text, "abc");
  } finally {
    conversationState.finishMessage(sessionId);
    unsubscribe();
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  }
});

test("a new message id replaces the previous streaming accumulation", () => {
  const sessionId = "test-streaming-message-identity";
  const unsubscribe = conversationState.subscribeStreaming(sessionId, () => {});

  conversationState.textDelta(sessionId, "message-1", "old");
  conversationState.thinkingStart(sessionId, "message-2");

  assert.deepEqual(conversationState.streamingSnapshot(sessionId), {
    messageId: "message-2",
    text: "",
    thinking: "",
    thinkingActive: true,
  });

  conversationState.clear(sessionId);
  unsubscribe();
});

test("notifies only the changed streaming or tool channel", () => {
  const sessionId = "test-subscription-isolation";
  let streamingCalls = 0;
  let firstToolCalls = 0;
  let secondToolCalls = 0;
  const unsubscribeStreaming = conversationState.subscribeStreaming(
    sessionId,
    () => streamingCalls++,
  );
  const unsubscribeFirstTool = conversationState.subscribeTool(
    sessionId,
    "tool-1",
    () => firstToolCalls++,
  );
  const unsubscribeSecondTool = conversationState.subscribeTool(
    sessionId,
    "tool-2",
    () => secondToolCalls++,
  );

  conversationState.textDelta(sessionId, "message-1", "hello");
  assert.deepEqual([streamingCalls, firstToolCalls, secondToolCalls], [1, 0, 0]);
  conversationState.tool(sessionId, { toolUseId: "tool-1", pending: true });
  assert.deepEqual([streamingCalls, firstToolCalls, secondToolCalls], [1, 1, 0]);
  conversationState.tool(sessionId, { toolUseId: "tool-2", pending: true });
  assert.deepEqual([streamingCalls, firstToolCalls, secondToolCalls], [1, 1, 1]);
  conversationState.clear(sessionId);
  assert.deepEqual([streamingCalls, firstToolCalls, secondToolCalls], [2, 2, 2]);

  unsubscribeStreaming();
  unsubscribeFirstTool();
  unsubscribeSecondTool();
});

test("rejects a stale snapshot from a previous conversation incarnation", () => {
  const sessionId = "test-stale-snapshot";
  const queryClient = new QueryClient();
  conversationState.reset(sessionId, { incarnation: "previous", sequence: 99 });
  conversationState.reset(sessionId, { incarnation: "current", sequence: 1 });
  conversationState.appendLiveItem(
    queryClient,
    sessionId,
    {
      id: "current-message",
      kind: "message",
      role: "assistant",
      content: "current",
      createdAt: "2026-08-05T00:00:00.000Z",
    },
    { incarnation: "current", sequence: 2 },
  );
  const current = queryClient.getQueryData(conversationState.historyQueryKey(sessionId));
  const stale = {
    pages: [
      {
        piSessionId: sessionId,
        sessionFile: null,
        historyPosition: { incarnation: "previous", sequence: 99 },
        items: [],
      },
    ],
    pageParams: [undefined],
  };

  const reconciled = conversationState.snapshotReconciler(sessionId)(current, stale);

  assert.equal(reconciled, current);
  assert.deepEqual(conversationState.position(sessionId), { incarnation: "current", sequence: 1 });
  conversationState.historyRewritten(sessionId);
});

test("accepts an authoritative snapshot from a new conversation incarnation", () => {
  const sessionId = "test-new-snapshot-incarnation";
  conversationState.reset(sessionId, { incarnation: "previous", sequence: 20 });
  const snapshot = {
    pages: [
      {
        piSessionId: sessionId,
        sessionFile: null,
        historyPosition: { incarnation: "current", sequence: 3 },
        items: [],
      },
    ],
    pageParams: [undefined],
  };

  const reconciled = conversationState.snapshotReconciler(sessionId)(undefined, snapshot);

  assert.deepEqual(reconciled, snapshot);
  assert.deepEqual(conversationState.position(sessionId), { incarnation: "current", sequence: 3 });
});

test("keeps live overlays pending across local TanStack Query writes", () => {
  const sessionId = "test-local-structural-sharing";
  const queryClient = new QueryClient();
  const queryKey = conversationState.historyQueryKey(sessionId);
  queryClient.setQueryDefaults(queryKey, {
    structuralSharing: conversationState.snapshotReconciler(sessionId),
  });
  conversationState.appendLiveItem(
    queryClient,
    sessionId,
    {
      id: "live-message",
      kind: "message",
      role: "assistant",
      content: "live",
      createdAt: "2026-08-05T00:00:00.000Z",
    },
    { incarnation: "current", sequence: 1 },
  );
  const current = queryClient.getQueryData(queryKey);
  const localRewrite = {
    pages: [{ piSessionId: sessionId, sessionFile: null, items: [] }],
    pageParams: [undefined],
  };

  const reconciled = conversationState.snapshotReconciler(sessionId)(current, localRewrite) as {
    pages: Array<{ items: Array<{ id: string }> }>;
  };

  assert.equal(reconciled.pages[0]?.items[0]?.id, "live-message");
  conversationState.historyRewritten(sessionId);
});

test("rejects network snapshots from an invalidated request generation", () => {
  const sessionId = "test-invalidated-snapshot-generation";
  const generation = conversationState.snapshotGeneration(sessionId);
  const stalePage = conversationState.tagSnapshot(sessionId, generation, {
    piSessionId: sessionId,
    sessionFile: null,
    historyPosition: { incarnation: "previous", sequence: 20 },
    items: [],
  });
  const current = { pages: [], pageParams: [] };
  conversationState.reset(sessionId, { incarnation: "current", sequence: 1 });

  const reconciled = conversationState.snapshotReconciler(sessionId)(current, {
    pages: [stalePage],
    pageParams: [undefined],
  });

  assert.equal(reconciled, current);
  assert.deepEqual(conversationState.position(sessionId), { incarnation: "current", sequence: 1 });
});

test("rejects a lower same-incarnation network watermark", () => {
  const sessionId = "test-snapshot-sequence-rollback";
  const generation = conversationState.snapshotGeneration(sessionId);
  const newerPage = conversationState.tagSnapshot(sessionId, generation, {
    piSessionId: sessionId,
    sessionFile: null,
    historyPosition: { incarnation: "current", sequence: 5 },
    items: [],
  });
  const newer = { pages: [newerPage], pageParams: [undefined] };
  conversationState.snapshotReconciler(sessionId)(undefined, newer);
  const olderPage = conversationState.tagSnapshot(sessionId, generation, {
    piSessionId: sessionId,
    sessionFile: null,
    historyPosition: { incarnation: "current", sequence: 3 },
    items: [],
  });

  const reconciled = conversationState.snapshotReconciler(sessionId)(newer, {
    pages: [olderPage],
    pageParams: [undefined],
  });

  assert.equal(reconciled, newer);
  assert.deepEqual(conversationState.position(sessionId), { incarnation: "current", sequence: 5 });
});

test("accepts an older-page fetch when the cached newest page has a lower watermark", () => {
  const sessionId = "test-older-page-watermark";
  const generation = conversationState.snapshotGeneration(sessionId);
  const cachedNewestPage = {
    piSessionId: sessionId,
    sessionFile: null,
    historyPosition: { incarnation: "current", sequence: 1 },
    items: [],
  };
  conversationState.snapshotReconciler(sessionId)(undefined, {
    pages: [
      conversationState.tagSnapshot(sessionId, generation, cachedNewestPage),
    ],
    pageParams: [undefined],
  });
  conversationState.observeEvent(sessionId, {
    type: "turn_end",
    piSessionId: sessionId,
    position: { incarnation: "current", sequence: 2 },
  });
  const oldData = { pages: [cachedNewestPage], pageParams: [undefined] };
  const olderPage = conversationState.tagSnapshot(sessionId, generation, {
    piSessionId: sessionId,
    sessionFile: null,
    historyPosition: { incarnation: "current", sequence: 2 },
    items: [],
  });
  const next = { pages: [olderPage, cachedNewestPage], pageParams: ["cursor", undefined] };

  const reconciled = conversationState.snapshotReconciler(sessionId)(oldData, next);

  assert.notEqual(reconciled, oldData);
  assert.equal((reconciled as typeof next).pages.length, 2);
});

test("uses snapshots without transient sessions as replay watermarks", () => {
  const sessionId = "test-snapshot-without-transient-session";
  const page = conversationState.tagSnapshot(
    sessionId,
    conversationState.snapshotGeneration(sessionId),
    {
      piSessionId: sessionId,
      sessionFile: null,
      historyPosition: { incarnation: "current", sequence: 4 },
      items: [],
    },
  );
  conversationState.snapshotReconciler(sessionId)(undefined, {
    pages: [page],
    pageParams: [undefined],
  });

  assert.deepEqual(conversationState.position(sessionId), { incarnation: "current", sequence: 4 });
  assert.equal(
    conversationState.observeEvent(sessionId, {
      type: "turn_end",
      piSessionId: sessionId,
      position: { incarnation: "current", sequence: 5 },
    }),
    "accept",
  );
  assert.equal(
    conversationState.observeEvent(sessionId, {
      type: "turn_end",
      piSessionId: sessionId,
      position: { incarnation: "current", sequence: 7 },
    }),
    "gap",
  );
});

test("ignores late events from superseded incarnations but recovers unknown ones", () => {
  const sessionId = "test-superseded-event";
  conversationState.reset(sessionId, { incarnation: "previous", sequence: 4 });
  conversationState.reset(sessionId, { incarnation: "current", sequence: 1 });

  assert.equal(
    conversationState.observeEvent(sessionId, {
      type: "turn_end",
      piSessionId: sessionId,
      position: { incarnation: "previous", sequence: 5 },
    }),
    "duplicate",
  );
  assert.equal(
    conversationState.observeEvent(sessionId, {
      type: "turn_end",
      piSessionId: sessionId,
      position: { incarnation: "unknown", sequence: 1 },
    }),
    "gap",
  );
  assert.equal(
    conversationState.observeEvent(sessionId, {
      type: "turn_end",
      piSessionId: sessionId,
      position: { incarnation: "unknown", sequence: 2 },
    }),
    "recovering",
  );
});

test("tool updates retain omitted partial results and notify on removal", () => {
  const sessionId = "test-tool-state";
  let calls = 0;
  const unsubscribe = conversationState.subscribeTool(sessionId, "tool-1", () => calls++);

  conversationState.tool(sessionId, {
    toolUseId: "tool-1",
    pending: true,
    partialResult: "partial",
    isError: false,
  });
  const firstSnapshot = conversationState.toolSnapshot(sessionId, "tool-1");
  conversationState.tool(sessionId, { toolUseId: "tool-1", pending: false });
  const settledSnapshot = conversationState.toolSnapshot(sessionId, "tool-1");

  assert.deepEqual(settledSnapshot, {
    toolUseId: "tool-1",
    pending: false,
    partialResult: "partial",
    isError: false,
  });
  assert.notEqual(firstSnapshot, settledSnapshot);

  conversationState.dropTool(sessionId, "tool-1");
  assert.equal(conversationState.toolSnapshot(sessionId, "tool-1"), undefined);
  assert.equal(calls, 3);
  unsubscribe();
});
