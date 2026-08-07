import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";

export function useCreateSwimlane() {
  const rootApi = getRouteApi("__root__");
  const { apiClient } = rootApi.useRouteContext();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => apiClient.createSwimlane(),
    onSuccess: async (stream) => {
      await queryClient.invalidateQueries({ queryKey: ["status"] });
      await navigate({
        to: "/streams/$piSessionId",
        params: { piSessionId: stream.piSessionId },
      });
    },
    onError: (error) => {
      toast.error(
        `Failed to create swimlane: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });
}
