import { createFileRoute } from "@tanstack/react-router";
import { Surface } from "@/components/surface";
import { useWhyDidYouRender } from "@/hooks/use-why-did-you-render";
import { surfaceTimelineInfiniteQueryOptions } from "@/lib/queries";

export const Route = createFileRoute("/")({
  staticData: {
    wsMode: "surface",
  },
  pendingMs: 0,
  loader: async ({ context }) => {
    try {
      await context.queryClient.ensureInfiniteQueryData(
        surfaceTimelineInfiniteQueryOptions(context.apiClient),
      );
    } catch {}
  },
  head: () => ({
    meta: [{ title: "Flitterbot" }],
  }),
  pendingComponent: SurfacePending,
  component: SurfacePage,
});

function SurfacePending() {
  return (
    <div className="flex h-full items-center justify-center px-6 py-4">
      <p className="text-xs text-text-muted">Loading chat UI…</p>
    </div>
  );
}

function SurfacePage() {
  useWhyDidYouRender("SurfacePage", {});
  return <Surface />;
}
