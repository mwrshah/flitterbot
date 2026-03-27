import type { AutonomaApiClient } from "~/lib/api";
import type { ChatTimelineItem, ConnectionState, StatusResponse } from "~/lib/types";
import { fetchPiHistory } from "~/server/pi";

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
    queryFn: (): ChatTimelineItem[] => [],
    staleTime: Infinity,
    // Seeded by route loader; WS bridge appends via setQueryData
  };
}
