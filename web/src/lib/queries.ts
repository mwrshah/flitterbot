import { keepPreviousData } from "@tanstack/react-query";
import type { AutonomaApiClient } from "~/lib/api";
import type { ChatTimelineItem, ConnectionState, DirectoryCompletionItem, StatusResponse } from "~/lib/types";
import { fetchDirectoryCompletions } from "~/server/directory-completions";
import { fetchPiHistory, fetchPiInputHistory, fetchPiSessions, fetchPiWorktree, type PiWorkstreamInfo } from "~/server/pi";
import type { DownstreamSessionItem } from "~/lib/types";

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
  queryClient?: { getQueryData: <T>(key: readonly unknown[]) => T | undefined },
) {
  const key = ["pi-history", sessionId ?? "default", surface ?? "agent"] as const;
  return {
    queryKey: key,
    queryFn: async (): Promise<ChatTimelineItem[]> => {
      const fetched = (await fetchPiHistory({
        data: {
          ...(sessionId ? { piSessionId: sessionId } : {}),
          ...(surface ? { surface } : {}),
        },
      })) as ChatTimelineItem[];

      // On refetch (reconnect), merge with WS-accumulated items to avoid
      // oscillation where server data replaces longer WS-accumulated data,
      // then WS events re-grow it.
      const existing = queryClient?.getQueryData<ChatTimelineItem[]>(key);
      if (!existing?.length) return fetched;

      const ids = new Set(fetched.map((item) => item.id));
      const extras = existing.filter((item) => !ids.has(item.id));
      if (!extras.length) return fetched;

      return [...fetched, ...extras];
    },
    enabled: sessionId !== undefined,
    staleTime: Infinity, // WS events keep this fresh via setQueryData
    // When the default session restarts with a new ID, the component picks up
    // the new sessionId from the status cache before the route loader re-runs.
    // Without placeholderData, useQuery returns undefined and usePiChat falls
    // back to stale loaderHistory (old session's messages). An empty placeholder
    // avoids showing the old session's data during the transition.
    placeholderData: [],
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
export function inputSurfaceTimelineQueryOptions(
  queryClient?: { getQueryData: <T>(key: readonly unknown[]) => T | undefined },
) {
  const key = ["pi-input-surface-timeline"] as const;
  return {
    queryKey: key,
    queryFn: async (): Promise<ChatTimelineItem[]> => {
      const fetched = (await fetchPiInputHistory()) as ChatTimelineItem[];

      // On refetch (reconnect), merge with WS-accumulated items to avoid
      // oscillation where server data replaces longer WS-accumulated data,
      // then WS events re-grow it.
      const existing = queryClient?.getQueryData<ChatTimelineItem[]>(key);
      if (!existing?.length) return fetched;
      const ids = new Set(fetched.map((item) => item.id));
      const extras = existing.filter((item) => !ids.has(item.id));
      if (!extras.length) return fetched;
      return [...fetched, ...extras];
    },
    staleTime: Infinity, // WS events keep this fresh via setQueryData
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
