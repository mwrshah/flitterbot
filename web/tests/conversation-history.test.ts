import assert from "node:assert/strict";
import test from "node:test";
import { type InfiniteData, infiniteQueryOptions, QueryClient } from "@tanstack/react-query";
import { createSurfaceLiveUpdater, surfaceQueryKey } from "../src/lib/conversation-history.ts";
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
  requests[1]!.resolve({ items: [message("server")] });

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
