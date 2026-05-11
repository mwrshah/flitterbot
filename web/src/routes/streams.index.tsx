import { createFileRoute, redirect } from "@tanstack/react-router";
import { statusQueryOptions } from "~/lib/queries";
import { getBestStreamPiSessionId } from "~/lib/stream-route-targets";

export const Route = createFileRoute("/streams/")({
  loader: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData(statusQueryOptions(context.apiClient));
    const piSessionId = getBestStreamPiSessionId(status);

    if (piSessionId) {
      throw redirect({ to: "/streams/$piSessionId", params: { piSessionId } });
    }
    throw redirect({ to: "/" });
  },
});
