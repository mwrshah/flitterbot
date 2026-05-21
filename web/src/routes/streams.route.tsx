import { createFileRoute, type ErrorComponentProps, Outlet } from "@tanstack/react-router";

import { statusQueryOptions } from "~/lib/queries";

export const Route = createFileRoute("/streams")({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(statusQueryOptions(context.apiClient));
  },
  errorComponent: ({ error }: ErrorComponentProps) => (
    <div className="flex items-center justify-center h-full p-8 text-destructive">
      <p>Failed to load Streams status: {String(error)}</p>
    </div>
  ),
  component: StreamsLayoutRoute,
});

function StreamsLayoutRoute() {
  return <Outlet />;
}
