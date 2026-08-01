import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import {
  appendItemToPage,
  commitMessageEndToPage,
  flattenHistoryPages,
  getHistoryPreviousPageParam,
  type HistoryInfiniteData,
  mergeHistoryPages,
  streamsHistoryQueryKey,
  updateNewestHistoryPage,
} from "../src/lib/history-cache.ts";

type TimelineItem = ReturnType<typeof flattenHistoryPages>[number];

function message(id: string, extra: Record<string, unknown> = {}): TimelineItem {
  return {
    id,
    kind: "message",
    role: "user",
    content: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  } as TimelineItem;
}

function tool(
  id: string,
  toolUseId: string,
  phase: "start" | "update" | "end" = "start",
): TimelineItem {
  return {
    id,
    kind: "tool",
    tool: "Bash",
    phase,
    toolUseId,
    createdAt: "2026-01-01T00:00:00.000Z",
  } as TimelineItem;
}

function historyPages(...groups: TimelineItem[][]): HistoryInfiniteData {
  return {
    pages: groups.map((items, index) => ({
      items,
      olderPageCursor: index === 0 ? null : `cursor-${index}`,
    })),
    pageParams: groups.map(() => undefined),
  };
}

test("history pages flatten chronologically and expose only the older cursor", () => {
  const data = historyPages([message("a"), message("b")], [message("c")]);

  assert.deepEqual(
    flattenHistoryPages(data).map((item) => item.id),
    ["a", "b", "c"],
  );
  assert.equal(getHistoryPreviousPageParam(data.pages[0]!), undefined);
  assert.equal(getHistoryPreviousPageParam(data.pages[1]!), "cursor-1");
});

test("live writes update only the newest loaded page", () => {
  const queryClient = new QueryClient();
  const key = streamsHistoryQueryKey("pi-1");
  const olderItems = [message("old")];
  queryClient.setQueryData(key, historyPages(olderItems, [message("newest")]));

  updateNewestHistoryPage(queryClient, "pi-1", (items) => [...items, message("live")]);

  const data = queryClient.getQueryData<HistoryInfiniteData>(key)!;
  assert.equal(data.pages[0]?.items, olderItems);
  assert.deepEqual(
    data.pages[1]?.items.map((item) => item.id),
    ["newest", "live"],
  );
  updateNewestHistoryPage(queryClient, "loading", (items) => [...items, message("in-flight")]);
  const seeded = queryClient.getQueryData<HistoryInfiniteData>(streamsHistoryQueryKey("loading"));
  assert.deepEqual(seeded?.pages[0]?.items.map((item) => item.id), ["in-flight"]);
});

test("live append deduplicates messages and active tool calls", () => {
  const items = [message("a"), tool("start", "use-1")];

  assert.equal(appendItemToPage(items, message("a")), items);
  assert.equal(appendItemToPage(items, tool("update", "use-1", "update")), items);
  assert.deepEqual(
    appendItemToPage(items, tool("end", "use-1", "end")).map((item) => item.id),
    ["a", "start", "end"],
  );
});

test("message completion replaces its optimistic row and appends tool calls", () => {
  const committed = message("server-1", { clientMessageId: "client-1" });
  const next = commitMessageEndToPage([message("client-1"), message("other")], {
    committed,
    clientMessageId: "client-1",
    isUser: true,
    toolItems: [tool("tool-1", "use-1")],
  });

  assert.deepEqual(
    next.map((item) => item.id),
    ["server-1", "other", "tool-1"],
  );
});

test("refetch reconciliation retains only uncommitted client rows", () => {
  const oldData = historyPages([message("client-1"), message("optimistic")]);
  const serverData = historyPages([message("server-1", { clientMessageId: "client-1" })]);

  const merged = mergeHistoryPages(oldData, serverData) as HistoryInfiniteData;

  assert.deepEqual(
    merged.pages[0]?.items.map((item) => item.id),
    ["server-1", "optimistic"],
  );
});
