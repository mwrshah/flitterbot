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
  const position = data?.pages.at(-1)?.resumePosition;
  return position ? { ...position } : undefined;
}

export function updateNewestHistoryPage(
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

export function removeNewestHistoryItem(
  queryClient: QueryClient,
  sessionId: string,
  itemId: string,
): void {
  updateNewestHistoryPage(queryClient, sessionId, (items) => {
    const next = items.filter((item) => item.id !== itemId);
    return next.length === items.length ? items : next;
  });
}
