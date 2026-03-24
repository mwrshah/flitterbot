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
    staleTime: 30_000,
  };
}
