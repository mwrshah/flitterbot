import { createFileRoute } from "@tanstack/react-router";
import { Surface } from "~/components/surface";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { surfaceTimelineQueryOptions } from "~/lib/queries";

export const Route = createFileRoute("/")({
  staticData: {
    wsMode: "surface",
  },
  head: () => ({
    meta: [{ title: "Autonoma — Surface" }],
  }),
  loader: async ({ context }) => {
    try {
      await context.queryClient.ensureQueryData(surfaceTimelineQueryOptions());
    } catch {
      // Leave cache unseeded; component falls back to empty array.
    }
  },
  component: SurfacePage,
});

function SurfacePage() {
  useWhyDidYouRender("SurfacePage", {});
  return <Surface />;
}
