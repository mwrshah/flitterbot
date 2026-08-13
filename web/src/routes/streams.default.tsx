import { createFileRoute, redirect } from "@tanstack/react-router";
import { statusQueryOptions } from "@/lib/queries";

export const Route = createFileRoute("/streams/default")({
  loader: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData(statusQueryOptions(context.apiClient));
    const piSessionId = status.piAgent?.default?.piSessionId;

    if (piSessionId) {
      throw redirect({ to: "/streams/$piSessionId", params: { piSessionId } });
    }
    throw redirect({ to: "/" });
  },
});
