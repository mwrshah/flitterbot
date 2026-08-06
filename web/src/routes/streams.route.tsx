import { createFileRoute, type ErrorComponentProps, Outlet } from "@tanstack/react-router";

import { statusQueryOptions } from "~/lib/queries";

export const Route = createFileRoute("/streams")({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(statusQueryOptions(context.apiClient));
  },
  errorComponent: ({ error }: ErrorComponentProps) => (
    <div className="flex h-full items-center justify-center p-8 text-status-crashed">
      <p>Failed to load Swimlanes status: {String(error)}</p>
    </div>
  ),
  component: StreamsLayoutRoute,
});

function StreamsLayoutRoute() {
  return <Outlet />;
}
