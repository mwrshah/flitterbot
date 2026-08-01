/**
 * Cache shape for the reverse-paginated agent history query.
 *
 * Pages are stored oldest -> newest (fetchPreviousPage unshifts), so a plain flatMap is already
 * chronological — never sort or reverse. Growth forward is WS-driven, so there is no next page and
 * only the newest page may be touched by live events. Refetching would re-fetch every loaded page,
 * so freshness comes from WS writes plus explicit invalidation on history_rewritten, aborted
 * agent_end, and WS reconnect.
 */
import { type InfiniteData, type QueryClient, replaceEqualDeep } from "@tanstack/react-query";
import type { ChatTimelineItem, ChatTimelineMessage, ChatTimelineTool } from "~/lib/types";
import type { StreamsHistoryPage } from "~/server/streams";

export type HistoryPageParam = string | undefined;
export type HistoryInfiniteData = InfiniteData<StreamsHistoryPage, unknown>;

const EMPTY_TIMELINE: ChatTimelineItem[] = [];

export function streamsHistoryQueryKey(piSessionId: string | undefined) {
  return ["streams-history", piSessionId ?? "default", "agent"] as const;
}

export function getHistoryPreviousPageParam(firstPage: StreamsHistoryPage): HistoryPageParam {
  return firstPage.olderPageCursor ?? undefined;
}

export function getHistoryNextPageParam(): HistoryPageParam {
  return undefined;
}

export const HISTORY_STALE_TIME = Number.POSITIVE_INFINITY;

export function flattenHistoryPages(data: HistoryInfiniteData | undefined): ChatTimelineItem[] {
  if (!data?.pages.length) return EMPTY_TIMELINE;
  if (data.pages.length === 1) return data.pages[0]?.items ?? EMPTY_TIMELINE;
  return data.pages.flatMap((page) => page.items);
}

export function updateNewestHistoryPage(
  queryClient: QueryClient,
  piSessionId: string | undefined,
  updater: (items: ChatTimelineItem[]) => ChatTimelineItem[],
): void {
  queryClient.setQueryData<HistoryInfiniteData>(streamsHistoryQueryKey(piSessionId), (old) => {
    if (!old?.pages.length) {
      const items = updater([]);
      if (!items.length) return old;
      return {
        pages: [{ items, olderPageCursor: null }],
        pageParams: [undefined],
      };
    }
    const lastIndex = old.pages.length - 1;
    const lastPage = old.pages[lastIndex];
    if (!lastPage) return old;

    const nextItems = updater(lastPage.items);
    if (nextItems === lastPage.items) return old;

    const pages = [...old.pages];
    pages[lastIndex] = { ...lastPage, items: nextItems };
    return { pages, pageParams: old.pageParams };
  });
}

export function appendItemToPage(
  items: ChatTimelineItem[],
  item: ChatTimelineItem,
): ChatTimelineItem[] {
  if (item.kind === "tool" && item.toolUseId) {
    const tool = item as ChatTimelineTool;
    if (tool.phase !== "end") {
      const activeDup = items.some(
        (existing) =>
          existing.kind === "tool" &&
          existing.toolUseId === tool.toolUseId &&
          existing.phase !== "end",
      );
      if (activeDup) return items;
    }
    const phaseDup = items.some(
      (existing) =>
        existing.kind === "tool" &&
        existing.toolUseId === tool.toolUseId &&
        existing.phase === tool.phase,
    );
    if (phaseDup) return items;
  } else if (item.kind === "message") {
    if (items.some((existing) => existing.id === item.id)) return items;
  }

  return [...items, item];
}

export type MessageEndCommit = {
  committed?: ChatTimelineMessage;
  clientMessageId?: string;
  isUser: boolean;
  toolItems: ChatTimelineTool[];
};

export function commitMessageEndToPage(
  items: ChatTimelineItem[],
  commit: MessageEndCommit,
): ChatTimelineItem[] {
  const { committed, clientMessageId, isUser, toolItems } = commit;
  let next = items;

  if (committed) {
    let idx = -1;
    if (isUser && clientMessageId) {
      idx = items.findIndex(
        (existing) => existing.kind === "message" && existing.id === clientMessageId,
      );
    }
    const committedServerMessageId = committed.serverMessageId;
    if (idx < 0 && committedServerMessageId) {
      idx = items.findIndex(
        (existing) =>
          existing.kind === "message" &&
          (existing.id === committedServerMessageId ||
            existing.serverMessageId === committedServerMessageId),
      );
    }
    if (idx < 0) {
      idx = items.findIndex((existing) => existing.id === committed.id);
    }

    if (idx >= 0) {
      next = [...items];
      next[idx] = committed;
    } else {
      next = [...items, committed];
    }
  }

  if (toolItems.length) {
    const base = next === items ? [...items] : next;
    for (const tool of toolItems) {
      const alreadyExists = base.some(
        (existing) =>
          existing.kind === "tool" &&
          existing.toolUseId === tool.toolUseId &&
          existing.phase !== "end",
      );
      if (!alreadyExists) base.push(tool);
    }
    next = base;
  }

  return next;
}

function mergeNewestPageItems(
  prev: ChatTimelineItem[],
  next: ChatTimelineItem[],
): ChatTimelineItem[] {
  if (!prev.length) return next;

  const serverIds = new Set<string>();
  for (const item of next) {
    serverIds.add(item.id);
    if (item.kind === "message") {
      if (item.serverMessageId) serverIds.add(item.serverMessageId);
      if (item.clientMessageId) serverIds.add(item.clientMessageId);
    }
    if (item.kind === "tool" && item.toolUseId) serverIds.add(item.toolUseId);
  }

  const clientOnlyExtras = prev.filter((item) => {
    if (serverIds.has(item.id)) return false;
    if (item.kind === "message") {
      if (item.serverMessageId && serverIds.has(item.serverMessageId)) return false;
      if (item.clientMessageId && serverIds.has(item.clientMessageId)) return false;
    }
    if (item.kind === "tool" && item.toolUseId && serverIds.has(item.toolUseId)) return false;
    return true;
  });

  return clientOnlyExtras.length ? [...next, ...clientOnlyExtras] : next;
}

export function mergeHistoryPages(oldData: unknown, newData: unknown): unknown {
  const prev = oldData as HistoryInfiniteData | undefined;
  const next = newData as HistoryInfiniteData;

  if (!prev?.pages.length || !next.pages.length) return replaceEqualDeep(prev, next);

  const prevLast = prev.pages[prev.pages.length - 1];
  const nextLastIndex = next.pages.length - 1;
  const nextLast = next.pages[nextLastIndex];
  if (!prevLast || !nextLast) return replaceEqualDeep(prev, next);

  const mergedItems = mergeNewestPageItems(prevLast.items, nextLast.items);
  if (mergedItems === nextLast.items) return replaceEqualDeep(prev, next);

  const pages = [...next.pages];
  pages[nextLastIndex] = { ...nextLast, items: mergedItems };
  return replaceEqualDeep(prev, { pages, pageParams: next.pageParams });
}
