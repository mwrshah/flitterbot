import { createFileRoute, type ErrorComponentProps, Outlet } from "@tanstack/react-router";
import { useWhyDidYouRender } from "@/hooks/use-why-did-you-render";
import { statusQueryOptions } from "@/lib/queries";

export const Route = createFileRoute("/streams")({
  loader: async ({ context }) => {
    await context.queryClient
      .ensureQueryData(statusQueryOptions(context.apiClient))
      .catch(() => undefined);
  },
  errorComponent: StreamsLoadError,
  component: StreamsLayoutRoute,
});

function StreamsLoadError({ error }: ErrorComponentProps) {
  useWhyDidYouRender?.("StreamsLoadError", {});
  return (
    <div className="flex h-full items-center justify-center p-8 text-status-crashed">
      <p>Failed to load Swimlanes status: {String(error)}</p>
    </div>
  );
}

function StreamsLayoutRoute() {
  useWhyDidYouRender?.("StreamsLayoutRoute", {});
  return <Outlet />;
}
