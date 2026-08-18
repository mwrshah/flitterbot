import { infiniteQueryOptions, keepPreviousData, queryOptions } from "@tanstack/react-query";
import type { DiffResult, FlitterbotApiClient, StreamInfo } from "@/lib/api";
import { findHistoryQueryKey, historyQueryKey, surfaceQueryKey } from "@/lib/conversation-history";
import { INTERNAL_COMMANDS } from "@/lib/internal-commands";
import type {
  DirectoryCompletionsResponse,
  DownstreamSessionItem,
  SkillPickerItem,
  StatusQueryData,
} from "@/lib/types";

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

export function streamsHistoryInfiniteQueryOptions(
  apiClient: FlitterbotApiClient,
  piSessionId: string | undefined,
) {
  return infiniteQueryOptions({
    queryKey: historyQueryKey(piSessionId),
    queryFn: async ({ pageParam, signal }) => {
      return apiClient.getStreamsHistory(
        {
          ...(piSessionId ? { piSessionId } : {}),
          surface: "agent",
          limit: pageParam
            ? STREAMS_HISTORY_PAGE_VISIBLE_ROW_LIMIT
            : STREAMS_HISTORY_INITIAL_VISIBLE_ROW_LIMIT,
          ...(pageParam ? { before: pageParam } : {}),
        },
        signal,
      );
    },
    initialPageParam: undefined as string | undefined,
    getPreviousPageParam: (firstPage) => firstPage.olderPageCursor ?? undefined,
    getNextPageParam: () => undefined,
    enabled: piSessionId !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: STREAMS_HISTORY_GC_TIME_MS,
  });
}

export function conversationFindHistoryQueryOptions(
  apiClient: FlitterbotApiClient,
  piSessionId: string,
) {
  return queryOptions({
    queryKey: findHistoryQueryKey(piSessionId),
    queryFn: ({ signal }) =>
      apiClient.getStreamsHistory({ piSessionId, surface: "agent", limit: "all" }, signal),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
  });
}

export function streamsDownstreamSessionsQueryOptions(
  apiClient: FlitterbotApiClient,
  piSessionId: string,
) {
  return {
    queryKey: ["streams-downstream-sessions", piSessionId] as const,
    queryFn: ({ signal }: { signal: AbortSignal }): Promise<DownstreamSessionItem[]> =>
      apiClient.getDownstreamSessions(piSessionId, signal),
    enabled: !!piSessionId,
    staleTime: 30_000,
  };
}

export function streamsWorktreeQueryOptions(apiClient: FlitterbotApiClient, piSessionId: string) {
  return {
    queryKey: ["streams-worktree", piSessionId] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<StreamInfo | null> => {
      try {
        return await apiClient.getStream(piSessionId, signal);
      } catch {
        return null;
      }
    },
    enabled: !!piSessionId,
    staleTime: 30_000,
  };
}

export function streamsDiffQueryOptions(
  apiClient: FlitterbotApiClient,
  piSessionId: string,
  enabled: boolean,
) {
  return {
    queryKey: ["streams-diff", piSessionId] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<DiffResult | null> => {
      try {
        return (await apiClient.getStreamDiff(piSessionId, signal)) ?? null;
      } catch {
        return null;
      }
    },
    enabled: !!piSessionId && enabled,
    staleTime: 10_000,
  };
}

export function userConfigQueryOptions(apiClient: FlitterbotApiClient) {
  return {
    queryKey: ["user-config"] as const,
    queryFn: async () => {
      try {
        return (await apiClient.getUserConfig("default_user")).config;
      } catch {
        return {};
      }
    },
    staleTime: 30_000,
  };
}

export function surfaceTimelineInfiniteQueryOptions(apiClient: FlitterbotApiClient) {
  return infiniteQueryOptions({
    queryKey: surfaceQueryKey,
    queryFn: async ({ pageParam, signal }) =>
      apiClient.getStreamsHistory(
        {
          surface: "input",
          limit: pageParam
            ? STREAMS_HISTORY_PAGE_VISIBLE_ROW_LIMIT
            : STREAMS_HISTORY_INITIAL_VISIBLE_ROW_LIMIT,
          ...(pageParam ? { before: pageParam } : {}),
        },
        signal,
      ),
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
      try {
        const res = await apiClient.listSkills();
        return [...INTERNAL_COMMANDS, ...res.items];
      } catch {
        return INTERNAL_COMMANDS;
      }
    },
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
  apiClient: FlitterbotApiClient,
  query: string,
  enabled: boolean,
  opts?: { streamId?: string; directoriesOnly?: boolean },
) {
  const streamId = opts?.streamId;
  const directoriesOnly = opts?.directoriesOnly ?? false;
  return {
    queryKey: ["directory-completions", query, streamId ?? "", directoriesOnly] as const,
    queryFn: ({ signal }: { signal: AbortSignal }): Promise<DirectoryCompletionsResponse> =>
      apiClient.getDirectoryCompletions({ query, streamId, directoriesOnly }, signal),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 5_000,
  };
}
