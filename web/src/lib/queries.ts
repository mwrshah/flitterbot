import { keepPreviousData } from "@tanstack/react-query";
import type { AutonomaApiClient } from "~/lib/api";
import type { ChatTimelineItem, ConnectionState, DirectoryCompletionItem, StatusResponse } from "~/lib/types";
import { fetchDirectoryCompletions } from "~/server/directory-completions";
import { fetchPiHistory, fetchPiInputHistory, fetchPiSessions, fetchPiWorktree, type PiWorkstreamInfo } from "~/server/pi";
import type { DownstreamSessionItem } from "~/lib/types";

/**
 * structuralSharing callback: merges fetched timeline with the previous cache
 * value. Items in the old cache that aren't present in the fetched result
 * (i.e. WS-accumulated items the server doesn't know about yet) are appended.
 * Returns the old reference unchanged when there's no diff (preserves React
 * memoization via referential equality, which is structuralSharing's contract).
 */
function mergeTimelineItems(
  oldData: unknown,
  newData: unknown,
): unknown {
  const prev = oldData as ChatTimelineItem[] | undefined;
  const next = newData as ChatTimelineItem[];

  if (!prev?.length) return next;

  const ids = new Set(next.map((item) => item.id));
  const extras = prev.filter((item) => !ids.has(item.id));
  if (!extras.length) {
    // All old items covered by server — check if identical to preserve reference
    return prev.length === next.length &&
      prev.every((item, i) => item.id === next[i]!.id)
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

export function piHistoryQueryOptions(
  sessionId: string | undefined,
  surface?: "input" | "agent",
) {
  return {
    queryKey: ["pi-history", sessionId ?? "default", surface ?? "agent"] as const,
    queryFn: async (): Promise<ChatTimelineItem[]> =>
      (await fetchPiHistory({
        data: {
          ...(sessionId ? { piSessionId: sessionId } : {}),
          ...(surface ? { surface } : {}),
        },
      })) as ChatTimelineItem[],
    enabled: sessionId !== undefined,
    staleTime: Infinity, // WS events keep this fresh via setQueryData
    // On refetch (reconnect), merge fetched data with WS-accumulated items
    // already in cache to prevent oscillation where server data replaces items
    // that only exist via setQueryData, then WS events re-grow them.
    structuralSharing: mergeTimelineItems,
  };
}

/**
 * Downstream Claude Code sessions for a Pi orchestrator session.
 * WS bridge invalidates ["pi-downstream-sessions", piSessionId] on sessions_changed.
 */
export function piDownstreamSessionsQueryOptions(piSessionId: string) {
  return {
    queryKey: ["pi-downstream-sessions", piSessionId] as const,
    queryFn: (): Promise<DownstreamSessionItem[]> =>
      fetchPiSessions({ data: { piSessionId } }),
    enabled: !!piSessionId,
    staleTime: 30_000,
  };
}

/**
 * Worktree info for a Pi orchestrator session.
 * WS bridge invalidates ["pi-worktree", piSessionId] on worktree_changed.
 */
export function piWorktreeQueryOptions(piSessionId: string) {
  return {
    queryKey: ["pi-worktree", piSessionId] as const,
    queryFn: (): Promise<PiWorkstreamInfo | null> =>
      fetchPiWorktree({ data: { piSessionId } }),
    enabled: !!piSessionId,
    staleTime: 30_000,
  };
}

/** Status pills per session — populated by WS bridge, never fetched from server. */
export type StatusPill = { id: string; label: string; variant?: "info" | "error" };

export function statusPillsQueryOptions(sessionId: string) {
  return {
    queryKey: ["pi-status-pills", sessionId] as const,
    queryFn: (): StatusPill[] => [],
    staleTime: Infinity,
    // Initialized as empty; WS bridge uses setQueryData to manage pills
  };
}

/** Connection state — managed by WS bridge via setQueryData. */
export function connectionStateQueryOptions() {
  return {
    queryKey: ["connection-state"] as const,
    queryFn: (): ConnectionState => "disconnected",
    staleTime: Infinity,
  };
}

/** Input surface timeline — pi_surfaced events + user messages from all sessions. */
export function inputSurfaceTimelineQueryOptions() {
  return {
    queryKey: ["pi-input-surface-timeline"] as const,
    queryFn: async (): Promise<ChatTimelineItem[]> =>
      (await fetchPiInputHistory()) as ChatTimelineItem[],
    staleTime: Infinity, // WS events keep this fresh via setQueryData
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
