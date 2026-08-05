import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import {
  historyQueryKey,
  latestHistoryPosition,
  removeNewestHistoryItem,
  upsertNewestHistoryItems,
} from "../src/lib/conversation-history.ts";

const message = (id: string, content: string) => ({
  id,
  kind: "message" as const,
  role: "assistant" as const,
  content,
  createdAt: "2026-08-05T00:00:00.000Z",
});

test("live commits update only loader-owned newest history page", () => {
  const queryClient = new QueryClient();
  const sessionId = "history-session";
  const oldest = {
    piSessionId: sessionId,
    sessionFile: null,
    items: [message("old", "old")],
  };
  const newest = {
    piSessionId: sessionId,
    sessionFile: null,
    resumePosition: { incarnation: "runtime", sequence: 5 },
    live: { tools: [] },
    items: [message("current", "before")],
  };
  queryClient.setQueryData(historyQueryKey(sessionId), {
    pages: [oldest, newest],
    pageParams: ["older", undefined],
  });

  upsertNewestHistoryItems(queryClient, sessionId, [
    message("current", "after"),
    message("new", "new"),
  ]);

  const data = queryClient.getQueryData<{
    pages: Array<{ items: Array<{ id: string; content: string }> }>;
    pageParams: Array<string | undefined>;
  }>(historyQueryKey(sessionId));
  assert.equal(data?.pages[0], oldest);
  assert.deepEqual(data?.pages[1]?.items.map(({ id, content }) => [id, content]), [
    ["current", "after"],
    ["new", "new"],
  ]);
  assert.deepEqual(data?.pageParams, ["older", undefined]);
  assert.deepEqual(latestHistoryPosition(queryClient, sessionId), {
    incarnation: "runtime",
    sequence: 5,
  });
});

test("WebSocket updates never create history before the loader", () => {
  const queryClient = new QueryClient();
  const sessionId = "missing-loader";
  upsertNewestHistoryItems(queryClient, sessionId, [message("new", "new")]);
  removeNewestHistoryItem(queryClient, sessionId, "new");
  assert.equal(queryClient.getQueryData(historyQueryKey(sessionId)), undefined);
});
