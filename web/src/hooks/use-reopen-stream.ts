import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { toast } from "sonner";
import type { StreamRecoveryKind } from "@/lib/stream-recovery";

type ReopenStreamVariables = {
  streamId: string;
  recoveryKind: StreamRecoveryKind;
};

export function useReopenStream() {
  const rootApi = getRouteApi("__root__");
  const { apiClient } = rootApi.useRouteContext();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ streamId }: ReopenStreamVariables) => apiClient.reopenStream(streamId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["status"] });
    },
    onError: (error, { recoveryKind }) => {
      toast.error(
        `Failed to ${recoveryKind === "dead" ? "recover" : "reopen"}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    },
  });
}
