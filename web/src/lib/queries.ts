import type { AutonomaApiClient } from "~/lib/api";
import type { StatusResponse } from "~/lib/types";

export function statusQueryOptions(apiClient: AutonomaApiClient) {
  return {
    queryKey: ["status"] as const,
    queryFn: (): Promise<StatusResponse> => apiClient.getStatus(),
    staleTime: 3_000,
  };
}
