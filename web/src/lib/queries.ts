import { keepPreviousData, replaceEqualDeep } from "@tanstack/react-query";
import type { AutonomaApiClient } from "~/lib/api";
import type { ChatTimelineItem, DownstreamSessionItem, StatusResponse } from "~/lib/types";
import {
  type DirectoryCompletionsResult,
  fetchDirectoryCompletions,
} from "~/server/directory-completions";
import {
  type DiffResult,
  fetchDownstreamSessions,
  fetchStreamsDiff,
  fetchStreamsHistory,
  fetchStreamsInputHistory,
  fetchStreamsWorktree,
  type StreamInfo,
} from "~/server/streams";
import { fetchUserConfig } from "~/server/user-config";

/**
 * structuralSharing callback: merges fetched timeline with the previous cache
 * value. Items in the old cache that aren't present in the fetched result
 * (i.e. WS-accumulated items the server doesn't know about yet) are appended.
 * Returns the old reference unchanged when there's no diff (preserves React
 * memoization via referential equality, which is structuralSharing's contract).
 */
function mergeTimelineItems(oldData: unknown, newData: unknown): unknown {
  const prev = oldData as ChatTimelineItem[] | undefined;
  const next = newData as ChatTimelineItem[];

  if (!prev?.length) return next;

  // Build a set of all identifiers from the server response: both `id` and any
  // `serverMessageId` values.  WS-accumulated items use ordinal IDs ("msg-N")
  // while the server returns the DB UUID as `id`.  The WS item's
  // `serverMessageId` matches the server's `id`, so we need to check both.
  const serverIds = new Set<string>();
  for (const item of next) {
    serverIds.add(item.id);
    const smId = (item as Record<string, unknown>).serverMessageId;
    if (typeof smId === "string") serverIds.add(smId);
    if (item.kind === "tool" && item.toolUseId) serverIds.add(item.toolUseId);
  }

  const extras = prev.filter((item) => {
    if (serverIds.has(item.id)) return false;
    const smId = (item as Record<string, unknown>).serverMessageId;
    if (typeof smId === "string" && serverIds.has(smId)) return false;
    if (item.kind === "tool" && item.toolUseId && serverIds.has(item.toolUseId)) return false;
    return true;
  });

  if (!extras.length) {
    // All old items covered by server — always use canonical server data.
    // ID-only equality was returning stale cached items whose content differed
    // (e.g. incomplete thinking blocks from intermediate WS snapshots).
    // Use replaceEqualDeep to preserve the old reference when data is
    // structurally identical, preventing unnecessary downstream re-renders.
    return replaceEqualDeep(prev, next);
  }

  return replaceEqualDeep(prev, [...next, ...extras]);
}

export function statusQueryOptions(apiClient: AutonomaApiClient) {
  return {
    queryKey: ["status"] as const,
    queryFn: (): Promise<StatusResponse> => apiClient.getStatus(),
    staleTime: 3_000,
  };
}

export function streamsHistoryQueryOptions(
  piSessionId: string | undefined,
  surface?: "input" | "agent",
) {
  return {
    queryKey: ["streams-history", piSessionId ?? "default", surface ?? "agent"] as const,
    queryFn: async (): Promise<ChatTimelineItem[]> =>
      (await fetchStreamsHistory({
        data: {
          ...(piSessionId ? { piSessionId } : {}),
          ...(surface ? { surface } : {}),
        },
      })) as ChatTimelineItem[],
    enabled: piSessionId !== undefined,
    staleTime: 0, // WS setQueryData resets dataUpdatedAt while viewing; on route leave WS unsubscribes so data goes stale naturally
    // When the default session restarts with a new ID, the component picks up
    // the new piSessionId from the status cache before the route loader re-runs.
    // Without placeholderData, useQuery returns undefined and useStreamsChat falls
    // back to stale loaderHistory (old session's messages). An empty placeholder
    // avoids showing the old session's data during the transition.
    placeholderData: [],
    // On refetch (reconnect), merge fetched data with WS-accumulated items
    // already in cache to prevent oscillation where server data replaces items
    // that only exist via setQueryData, then WS events re-grow them.
    structuralSharing: mergeTimelineItems,
  };
}

/**
 * Downstream Claude Code sessions for a Streams orchestrator session.
 * WS bridge invalidates ["streams-downstream-sessions", piSessionId] on sessions_changed.
 */
export function streamsDownstreamSessionsQueryOptions(piSessionId: string) {
  return {
    queryKey: ["streams-downstream-sessions", piSessionId] as const,
    queryFn: (): Promise<DownstreamSessionItem[]> =>
      fetchDownstreamSessions({ data: { piSessionId } }),
    enabled: !!piSessionId,
    staleTime: 30_000,
  };
}

/**
 * Worktree info for a Streams orchestrator session.
 * WS bridge invalidates ["streams-worktree", piSessionId] on worktree_changed.
 */
export function streamsWorktreeQueryOptions(piSessionId: string) {
  return {
    queryKey: ["streams-worktree", piSessionId] as const,
    queryFn: (): Promise<StreamInfo | null> => fetchStreamsWorktree({ data: { piSessionId } }),
    enabled: !!piSessionId,
    staleTime: 30_000,
  };
}

/**
 * Git diff (against main) for a stream's worktree.
 * Only fetched when the diff panel toggle is active.
 */
export function streamsDiffQueryOptions(piSessionId: string, enabled: boolean) {
  return {
    queryKey: ["streams-diff", piSessionId] as const,
    queryFn: (): Promise<DiffResult | null> => fetchStreamsDiff({ data: { piSessionId } }),
    enabled: !!piSessionId && enabled,
    staleTime: 10_000,
  };
}

/** Status pills per session — populated by WS bridge, never fetched from server. */
export type StatusPill = { id: string; label: string; variant?: "info" | "error" };

/** User config (panel layouts, theme, etc.) — prefetched in root loader. */
export function userConfigQueryOptions() {
  return {
    queryKey: ["user-config"] as const,
    queryFn: () => fetchUserConfig(),
    staleTime: 30_000,
  };
}

export function statusPillsQueryOptions(piSessionId: string) {
  return {
    queryKey: ["streams-status-pills", piSessionId] as const,
    queryFn: (): StatusPill[] => [],
    staleTime: Infinity,
    // Initialized as empty; WS bridge uses setQueryData to manage pills
  };
}

/** Surface timeline — stream_surfaced events + user messages from all sessions. */
export function surfaceTimelineQueryOptions() {
  return {
    queryKey: ["surface-timeline"] as const,
    queryFn: async (): Promise<ChatTimelineItem[]> =>
      (await fetchStreamsInputHistory()) as ChatTimelineItem[],
    staleTime: 0, // WS setQueryData resets dataUpdatedAt while viewing; on route leave WS unsubscribes so data goes stale naturally
    structuralSharing: mergeTimelineItems,
  };
}

/** Directory completions for the @-mention path picker. */
export function directoryCompletionsQueryOptions(
  query: string,
  enabled: boolean,
  opts?: { streamId?: string },
) {
  const streamId = opts?.streamId;
  return {
    queryKey: ["directory-completions", query, streamId ?? ""] as const,
    queryFn: (): Promise<DirectoryCompletionsResult> =>
      fetchDirectoryCompletions({
        data: { query, streamId },
      }),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 5_000,
  };
}
