import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type { ConversationEventPosition } from "../../../src/contracts/websocket.ts";
import type { ChatTimelineItem, StreamsHistoryResponse } from "./types";

export const surfaceQueryKey = ["surface-timeline"] as const;

export function historyQueryKey(sessionId: string | undefined) {
  return ["streams-history", sessionId ?? "default", "agent"] as const;
}

export function latestHistoryPosition(
  queryClient: QueryClient,
  sessionId: string,
): ConversationEventPosition | undefined {
  const data = queryClient.getQueryData<InfiniteData<StreamsHistoryResponse, string | undefined>>(
    historyQueryKey(sessionId),
  );
  const position = data?.pages.at(-1)?.historyPosition;
  return position ? { ...position } : undefined;
}

function updateNewestHistoryPage(
  queryClient: QueryClient,
  sessionId: string,
  update: (items: ChatTimelineItem[]) => ChatTimelineItem[],
): void {
  queryClient.setQueryData<InfiniteData<StreamsHistoryResponse, string | undefined>>(
    historyQueryKey(sessionId),
    (current) => {
      if (!current?.pages.length) return current;
      const newestIndex = current.pages.length - 1;
      const newestPage = current.pages[newestIndex]!;
      const items = update(newestPage.items);
      if (items === newestPage.items) return current;
      const pages = [...current.pages];
      pages[newestIndex] = { ...newestPage, items };
      return { pages, pageParams: current.pageParams };
    },
  );
}

function upsertNewestSurfaceItem(queryClient: QueryClient, incoming: ChatTimelineItem): void {
  queryClient.setQueryData<InfiniteData<StreamsHistoryResponse, string | undefined>>(
    surfaceQueryKey,
    (current) => {
      if (!current?.pages.length) return current;

      let foundPageIndex = -1;
      let foundItemIndex = -1;
      for (let pageIndex = 0; pageIndex < current.pages.length; pageIndex++) {
        const itemIndex = current.pages[pageIndex]!.items.findIndex(
          (item) => item.id === incoming.id,
        );
        if (itemIndex >= 0) {
          foundPageIndex = pageIndex;
          foundItemIndex = itemIndex;
          break;
        }
      }

      const pageIndex = foundPageIndex >= 0 ? foundPageIndex : current.pages.length - 1;
      const page = current.pages[pageIndex]!;
      const items = [...page.items];
      if (foundItemIndex >= 0) items[foundItemIndex] = incoming;
      else items.push(incoming);

      const pages = [...current.pages];
      pages[pageIndex] = { ...page, items };
      return { pages, pageParams: current.pageParams };
    },
  );
}

export function createSurfaceLiveUpdater(
  queryClient: QueryClient,
  ensureSurfaceData: () => Promise<unknown>,
): { update(item: ChatTimelineItem): Promise<void>; dispose(): void } {
  const pending = new Map<string, ChatTimelineItem>();
  let flushing: Promise<void> | undefined;
  let disposed = false;

  const flush = async () => {
    while (!disposed && pending.size > 0) {
      await queryClient.cancelQueries({ queryKey: surfaceQueryKey, exact: true });
      if (disposed) return;
      if (!queryClient.getQueryData(surfaceQueryKey)) await ensureSurfaceData();
      if (disposed || !queryClient.getQueryData(surfaceQueryKey)) return;

      const batch = [...pending.values()];
      if (disposed) return;
      pending.clear();
      for (const item of batch) upsertNewestSurfaceItem(queryClient, item);
    }
  };

  const scheduleFlush = () => {
    if (disposed || flushing || pending.size === 0) return;
    flushing = flush()
      .catch(() => {})
      .finally(() => {
        flushing = undefined;
        if (queryClient.getQueryData(surfaceQueryKey)) scheduleFlush();
      });
  };

  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (event.query.queryHash === JSON.stringify(surfaceQueryKey) && event.query.state.data) {
      scheduleFlush();
    }
  });

  return {
    update(item) {
      pending.set(item.id, item);
      scheduleFlush();
      return flushing ?? Promise.resolve();
    },
    dispose() {
      disposed = true;
      pending.clear();
      unsubscribe();
    },
  };
}

export function upsertNewestHistoryItems(
  queryClient: QueryClient,
  sessionId: string,
  incoming: ChatTimelineItem[],
): void {
  if (!incoming.length) return;
  updateNewestHistoryPage(queryClient, sessionId, (items) => {
    const indexes = new Map(items.map((item, index) => [item.id, index]));
    const next = [...items];
    for (const item of incoming) {
      const index = indexes.get(item.id);
      if (index === undefined) {
        indexes.set(item.id, next.length);
        next.push(item);
      } else {
        next[index] = item;
      }
    }
    return next;
  });
}
