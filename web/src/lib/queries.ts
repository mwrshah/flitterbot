import { infiniteQueryOptions, keepPreviousData, queryOptions } from "@tanstack/react-query";
import type { FlitterbotApiClient } from "@/lib/api";
import { findHistoryQueryKey, historyQueryKey, surfaceQueryKey } from "@/lib/conversation-history";
import { INTERNAL_COMMANDS } from "@/lib/internal-commands";
import type {
  DirectoryCompletionsResponse,
  DownstreamSessionItem,
  DueTasksResponse,
  SkillPickerItem,
  StatusQueryData,
} from "@/lib/types";
import { fetchDirectoryCompletions } from "@/server/directory-completions";
import {
  type DiffResult,
  fetchDownstreamSessions,
  fetchStreamsDiff,
  fetchStreamsHistory,
  fetchStreamsWorktree,
  type StreamInfo,
} from "@/server/streams";
import { fetchDueTasks } from "@/server/tasks";
import { fetchUserConfig } from "@/server/user-config";

export function statusQueryOptions(apiClient: FlitterbotApiClient) {
  return {
    queryKey: ["status"] as const,
    queryFn: async (): Promise<StatusQueryData> => {
      try {
        return await apiClient.getStatus();
      } catch {
        return {
          source: "offline",
          uptime: 0,
          blackboard: "",
          whatsapp: { status: "disconnected" },
          streams: [],
          shortcuts: {},
        };
      }
    },
    staleTime: 3_000,
  };
}

const STREAMS_HISTORY_INITIAL_VISIBLE_ROW_LIMIT = 30;
const STREAMS_HISTORY_PAGE_VISIBLE_ROW_LIMIT = 10;
const STREAMS_HISTORY_GC_TIME_MS = 30_000;

export function streamsHistoryInfiniteQueryOptions(piSessionId: string | undefined) {
  return infiniteQueryOptions({
    queryKey: historyQueryKey(piSessionId),
    queryFn: async ({ pageParam }) => {
      return fetchStreamsHistory({
        data: {
          ...(piSessionId ? { piSessionId } : {}),
          surface: "agent",
          limit: pageParam
            ? STREAMS_HISTORY_PAGE_VISIBLE_ROW_LIMIT
            : STREAMS_HISTORY_INITIAL_VISIBLE_ROW_LIMIT,
          ...(pageParam ? { before: pageParam } : {}),
        },
      });
    },
    initialPageParam: undefined as string | undefined,
    getPreviousPageParam: (firstPage) => firstPage.olderPageCursor ?? undefined,
    getNextPageParam: () => undefined,
    enabled: piSessionId !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: STREAMS_HISTORY_GC_TIME_MS,
  });
}

export function conversationFindHistoryQueryOptions(piSessionId: string) {
  return queryOptions({
    queryKey: findHistoryQueryKey(piSessionId),
    queryFn: ({ signal }) =>
      fetchStreamsHistory({
        signal,
        data: { piSessionId, surface: "agent", limit: "all" },
      }),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
  });
}

export const DUE_TASKS_QUERY_KEY = ["due-tasks"] as const;

export function dueTasksQueryOptions() {
  return queryOptions({
    queryKey: DUE_TASKS_QUERY_KEY,
    queryFn: (): Promise<DueTasksResponse> => fetchDueTasks(),
    staleTime: 30_000,
  });
}

export function streamsDownstreamSessionsQueryOptions(piSessionId: string, enabled = true) {
  return {
    queryKey: ["streams-downstream-sessions", piSessionId] as const,
    queryFn: (): Promise<DownstreamSessionItem[]> =>
      fetchDownstreamSessions({ data: { piSessionId } }),
    enabled: !!piSessionId && enabled,
    staleTime: 30_000,
  };
}

export function streamsWorktreeQueryOptions(piSessionId: string) {
  return {
    queryKey: ["streams-worktree", piSessionId] as const,
    queryFn: (): Promise<StreamInfo | null> => fetchStreamsWorktree({ data: { piSessionId } }),
    enabled: !!piSessionId,
    staleTime: 30_000,
  };
}

export function streamsDiffQueryOptions(piSessionId: string, enabled: boolean) {
  return {
    queryKey: ["streams-diff", piSessionId] as const,
    queryFn: (): Promise<DiffResult | null> => fetchStreamsDiff({ data: { piSessionId } }),
    enabled: !!piSessionId && enabled,
    staleTime: 10_000,
  };
}

export function userConfigQueryOptions() {
  return {
    queryKey: ["user-config"] as const,
    queryFn: async () => {
      try {
        return await fetchUserConfig();
      } catch {
        return {};
      }
    },
    staleTime: 30_000,
  };
}

export function surfaceTimelineInfiniteQueryOptions() {
  return infiniteQueryOptions({
    queryKey: surfaceQueryKey,
    queryFn: async ({ pageParam }) =>
      fetchStreamsHistory({
        data: {
          surface: "input",
          limit: pageParam
            ? STREAMS_HISTORY_PAGE_VISIBLE_ROW_LIMIT
            : STREAMS_HISTORY_INITIAL_VISIBLE_ROW_LIMIT,
          ...(pageParam ? { before: pageParam } : {}),
        },
      }),
    initialPageParam: undefined as string | undefined,
    getPreviousPageParam: (firstPage) => firstPage.olderPageCursor ?? undefined,
    getNextPageParam: () => undefined,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function skillsQueryOptions(apiClient: FlitterbotApiClient) {
  return {
    queryKey: ["skills"] as const,
    queryFn: async (): Promise<SkillPickerItem[]> => {
      const res = await apiClient.listSkills();
      return [...INTERNAL_COMMANDS, ...res.items];
    },
    retry: 5,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  };
}

export function sessionSearchQueryOptions(
  apiClient: FlitterbotApiClient,
  query: string,
  enabled: boolean,
) {
  return {
    queryKey: ["session-search", query] as const,
    queryFn: () => apiClient.searchSessions(query),
    enabled,
    placeholderData: keepPreviousData,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  };
}

export function directoryCompletionsQueryOptions(
  query: string,
  enabled: boolean,
  opts?: { streamId?: string; baseCwd?: string; directoriesOnly?: boolean },
) {
  const streamId = opts?.streamId;
  const baseCwd = opts?.baseCwd;
  const directoriesOnly = opts?.directoriesOnly ?? false;
  return {
    queryKey: [
      "directory-completions",
      query,
      streamId ?? "",
      baseCwd ?? "",
      directoriesOnly,
    ] as const,
    queryFn: (): Promise<DirectoryCompletionsResponse> =>
      fetchDirectoryCompletions({
        data: { query, streamId, baseCwd, directoriesOnly },
      }),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 5_000,
  };
}
