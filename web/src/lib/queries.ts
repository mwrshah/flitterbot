import type { AutonomaApiClient } from "~/lib/api";
import type { ChatTimelineItem, StatusResponse } from "~/lib/types";
import { fetchPiHistory } from "~/server/pi";

export function statusQueryOptions(apiClient: AutonomaApiClient) {
  return {
    queryKey: ["status"] as const,
    queryFn: (): Promise<StatusResponse> => apiClient.getStatus(),
    staleTime: 3_000,
  };
}

export function piHistoryQueryOptions(sessionId: string | undefined, surface?: "input" | "agent") {
  return {
    queryKey: ["pi-history", sessionId ?? "default", surface ?? "agent"] as const,
    queryFn: async (): Promise<ChatTimelineItem[]> => {
      const items = await fetchPiHistory({
        data: {
          ...(sessionId ? { piSessionId: sessionId } : {}),
          ...(surface ? { surface } : {}),
        },
      });
      return items as ChatTimelineItem[];
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

/** Input surface timeline — pi_surfaced events + user messages from all sessions. */
export function inputSurfaceTimelineQueryOptions() {
  return {
    queryKey: ["pi-input-surface-timeline"] as const,
    queryFn: (): ChatTimelineItem[] => [],
    staleTime: Infinity,
    // Seeded by route loader; WS bridge appends via setQueryData
  };
}
