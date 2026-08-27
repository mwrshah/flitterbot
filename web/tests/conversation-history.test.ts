import assert from "node:assert/strict";
import test from "node:test";
import { type InfiniteData, infiniteQueryOptions, QueryClient } from "@tanstack/react-query";
import {
  createSurfaceLiveUpdater,
  historyQueryKey,
  refreshHistorySnapshot,
  surfaceQueryKey,
  upsertNewestHistoryItems,
} from "../src/lib/conversation-history.ts";
import type { ChatTimelineMessage, StreamsHistoryResponse } from "../src/lib/types.ts";

function message(id: string, content = id): ChatTimelineMessage {
  return {
    id,
    kind: "message",
    role: "assistant",
    content,
    createdAt: "2026-08-06T00:00:00.000Z",
  };
}

function userMessage(id: string, content = id): ChatTimelineMessage {
  return { ...message(id, content), role: "user" };
}

test("history recovery preserves an in-flight initial query", async () => {
  const sessionId = "session";
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let resolveRequest: ((data: StreamsHistoryResponse) => void) | undefined;
  let requestCount = 0;
  const options = infiniteQueryOptions({
    queryKey: historyQueryKey(sessionId),
    queryFn: ({ signal }) =>
      new Promise<StreamsHistoryResponse>((resolve, reject) => {
        requestCount++;
        resolveRequest = resolve;
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      }),
    initialPageParam: undefined as string | undefined,
    getPreviousPageParam: () => undefined,
  });

  const initialLoad = queryClient.ensureInfiniteQueryData(options);
  await waitFor(() => requestCount === 1);
  const recovery = refreshHistorySnapshot(queryClient, sessionId);
  resolveRequest?.({
    items: [message("loaded")],
    totalUserMessages: 0,
    historyPosition: { incarnation: "runtime", sequence: 1 },
  });

  await Promise.all([initialLoad, recovery]);
  assert.equal(requestCount, 1);
  assert.equal(queryClient.getQueryState(historyQueryKey(sessionId))?.status, "success");
  queryClient.clear();
});

test("history recovery discards old pagination before refreshing the newest snapshot", async () => {
  const sessionId = "session";
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let newestVersion = 0;
  const options = infiniteQueryOptions({
    queryKey: historyQueryKey(sessionId),
    queryFn: async () => ({
      items: [message(`newest-${++newestVersion}`)],
      totalUserMessages: 0,
      historyPosition: { incarnation: "runtime", sequence: newestVersion },
      olderPageCursor: "older",
    }),
    initialPageParam: undefined as string | undefined,
    getPreviousPageParam: (firstPage) => firstPage.olderPageCursor ?? undefined,
  });
  const initial = await queryClient.ensureInfiniteQueryData(options);
  queryClient.setQueryData<InfiniteData<StreamsHistoryResponse, string | undefined>>(
    historyQueryKey(sessionId),
    {
      pages: [{ items: [message("older")], totalUserMessages: 0 }, initial.pages[0]!],
      pageParams: ["older", undefined],
    },
  );

  await refreshHistorySnapshot(queryClient, sessionId);

  const result = queryClient.getQueryData<InfiniteData<StreamsHistoryResponse, string | undefined>>(
    historyQueryKey(sessionId),
  )!;
  assert.deepEqual(
    result.pages.map((page) => page.items.map((item) => item.id)),
    [["newest-2"]],
  );
  assert.deepEqual(result.pageParams, [undefined]);
  assert.deepEqual(result.pages[0]?.historyPosition, { incarnation: "runtime", sequence: 2 });
  queryClient.clear();
});

test("history live upserts update the full user-message total once", () => {
  const sessionId = "session";
  const queryClient = new QueryClient();
  queryClient.setQueryData<InfiniteData<StreamsHistoryResponse, string | undefined>>(
    historyQueryKey(sessionId),
    {
      pages: [{ items: [userMessage("loaded-user")], totalUserMessages: 7 }],
      pageParams: [undefined],
    },
  );
  const total = () =>
    queryClient
      .getQueryData<InfiniteData<StreamsHistoryResponse, string | undefined>>(
        historyQueryKey(sessionId),
      )!
      .pages.at(-1)!.totalUserMessages;

  upsertNewestHistoryItems(queryClient, sessionId, [userMessage("new-user")]);
  assert.equal(total(), 8);

  upsertNewestHistoryItems(queryClient, sessionId, [userMessage("new-user", "replacement")]);
  assert.equal(total(), 8);

  upsertNewestHistoryItems(queryClient, sessionId, [message("new-assistant")]);
  assert.equal(total(), 8);

  upsertNewestHistoryItems(queryClient, sessionId, [message("new-user", "role replacement")]);
  assert.equal(total(), 7);
  queryClient.clear();
});

test("surface live events survive an initial-query race without duplication", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const requests: Array<{
    resolve: (data: StreamsHistoryResponse) => void;
    reject: (error: Error) => void;
  }> = [];
  const options = infiniteQueryOptions({
    queryKey: surfaceQueryKey,
    queryFn: ({ signal }) =>
      new Promise<StreamsHistoryResponse>((resolve, reject) => {
        requests.push({ resolve, reject });
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      }),
    initialPageParam: undefined as string | undefined,
    getPreviousPageParam: () => undefined,
  });
  const initialLoad = queryClient.ensureInfiniteQueryData(options).catch(() => undefined);
  await waitFor(() => requests.length === 1);

  const updater = createSurfaceLiveUpdater(queryClient, () =>
    queryClient.ensureInfiniteQueryData(options),
  );
  const firstVersion = updater.update(message("live-1", "first"));
  await waitFor(() => requests.length === 2);
  const replacement = updater.update(message("live-1", "replacement"));
  const secondEvent = updater.update(message("live-2"));
  requests[1]!.resolve({ items: [message("server")], totalUserMessages: 0 });

  await Promise.all([initialLoad, firstVersion, replacement, secondEvent]);
  const result =
    queryClient.getQueryData<InfiniteData<StreamsHistoryResponse, string | undefined>>(
      surfaceQueryKey,
    )!;
  assert.deepEqual(
    result.pages.flatMap((page) => page.items).map((item) => [item.id, item.content]),
    [
      ["server", "server"],
      ["live-1", "replacement"],
      ["live-2", "live-2"],
    ],
  );
  updater.dispose();
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("condition was not reached");
}
