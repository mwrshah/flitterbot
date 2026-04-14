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
    meta: [{ title: "Flitterbot" }],
  }),
  loader: async ({ context }) => {
    try {
      await context.queryClient.ensureQueryData(surfaceTimelineQueryOptions());
    } catch {
      // Leave cache unseeded; component falls back to empty array.
    }
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
