import { createFileRoute } from "@tanstack/react-router";
import { Surface } from "~/components/surface";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { surfaceTimelineQueryOptions } from "~/lib/queries";

export const Route = createFileRoute("/")({
  staticData: {
    wsMode: "surface",
  },
  pendingMs: 0,
  head: () => ({
    meta: [{ title: "Autonoma — Surface" }],
  }),
  loader: async ({ context }) => {
    const t0 = performance.now();
    const queryKey = ["surface-timeline"];
    const cachedData = context.queryClient.getQueryData(queryKey);
    const queryState = context.queryClient.getQueryState(queryKey);
    console.log("[loader:/] START", {
      ts: new Date().toISOString(),
      hasCachedData: !!cachedData,
      cachedDataLength: Array.isArray(cachedData) ? cachedData.length : null,
      dataUpdatedAt: queryState?.dataUpdatedAt ? new Date(queryState.dataUpdatedAt).toISOString() : null,
    });

    try {
      await context.queryClient.ensureQueryData(surfaceTimelineQueryOptions());
    } catch {
      // Leave cache unseeded; component falls back to empty array.
    }

    console.log("[loader:/] END", { elapsed: `${(performance.now() - t0).toFixed(1)}ms` });
  },
  pendingComponent: SurfacePending,
  component: SurfacePage,
});

function SurfacePending() {
  return (
    <div className="flex h-full items-center justify-center px-6 py-4">
      <p className="text-xs text-muted-foreground">Loading chat UI…</p>
    </div>
  );
}

function SurfacePage() {
  useWhyDidYouRender("SurfacePage", {});
  return <Surface />;
}
