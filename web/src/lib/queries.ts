import { keepPreviousData } from "@tanstack/react-query";
import type { AutonomaApiClient } from "~/lib/api";
import type {
  ChatTimelineItem,
  DirectoryCompletionItem,
  DownstreamSessionItem,
  StatusResponse,
} from "~/lib/types";
import { fetchDirectoryCompletions } from "~/server/directory-completions";
import {
  fetchDownstreamSessions,
  fetchStreamsDiff,
  fetchStreamsHistory,
  fetchStreamsInputHistory,
  fetchStreamsWorktree,
  type DiffResult,
  type StreamInfo,
} from "~/server/streams";

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

  const ids = new Set(next.map((item) => item.id));
  const extras = prev.filter((item) => !ids.has(item.id));
  if (!extras.length) {
    // All old items covered by server — check if identical to preserve reference
    return prev.length === next.length && prev.every((item, i) => item.id === next[i]!.id)
      ? prev
      : next;
  }

  return [...next, ...extras];
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
export function directoryCompletionsQueryOptions(pathFilter: string, enabled: boolean) {
  return {
    queryKey: ["directory-completions", pathFilter] as const,
    queryFn: (): Promise<DirectoryCompletionItem[]> =>
      fetchDirectoryCompletions({ data: { path: pathFilter } }),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 5_000,
  };
}
