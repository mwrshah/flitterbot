import { infiniteQueryOptions, keepPreviousData, replaceEqualDeep } from "@tanstack/react-query";
import type { FlitterbotApiClient } from "~/lib/api";
import { conversationState } from "~/lib/conversation-state";
import { INTERNAL_COMMANDS } from "~/lib/internal-commands";
import type {
  ChatTimelineItem,
  DirectoryCompletionsResponse,
  DownstreamSessionItem,
  SkillPickerItem,
  StatusQueryData,
} from "~/lib/types";
import { fetchDirectoryCompletions } from "~/server/directory-completions";
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

export function streamsHistoryInfiniteQueryOptions(piSessionId: string | undefined) {
  return infiniteQueryOptions({
    queryKey: conversationState.historyQueryKey(piSessionId),
    queryFn: ({ pageParam }) =>
      fetchStreamsHistory({
        data: {
          ...(piSessionId ? { piSessionId } : {}),
          surface: "agent",
          ...(pageParam ? { before: pageParam } : {}),
        },
      }),
    initialPageParam: undefined as string | undefined,
    getPreviousPageParam: (firstPage) => firstPage.olderPageCursor ?? undefined,
    getNextPageParam: () => undefined,
    enabled: piSessionId !== undefined,
    staleTime: conversationState.historyStaleTime,
    gcTime: 0,
    structuralSharing: conversationState.snapshotReconciler(piSessionId ?? "default"),
  });
}

export function streamsDownstreamSessionsQueryOptions(piSessionId: string) {
  return {
    queryKey: ["streams-downstream-sessions", piSessionId] as const,
    queryFn: (): Promise<DownstreamSessionItem[]> =>
      fetchDownstreamSessions({ data: { piSessionId } }),
    enabled: !!piSessionId,
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

export function surfaceTimelineQueryOptions() {
  return {
    queryKey: conversationState.surfaceQueryKey,
    queryFn: async (): Promise<ChatTimelineItem[]> =>
      (await fetchStreamsInputHistory()) as ChatTimelineItem[],
    staleTime: 0, // WS writes reset dataUpdatedAt while viewing
    structuralSharing: replaceEqualDeep,
  };
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

export function directoryCompletionsQueryOptions(
  query: string,
  enabled: boolean,
  opts?: { streamId?: string; directoriesOnly?: boolean },
) {
  const streamId = opts?.streamId;
  const directoriesOnly = opts?.directoriesOnly ?? false;
  return {
    queryKey: ["directory-completions", query, streamId ?? "", directoriesOnly] as const,
    queryFn: (): Promise<DirectoryCompletionsResponse> =>
      fetchDirectoryCompletions({
        data: { query, streamId, directoriesOnly },
      }),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 5_000,
  };
}
