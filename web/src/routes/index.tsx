import { createFileRoute } from "@tanstack/react-router";
import { InputSurface } from "~/components/input-surface";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { inputSurfaceTimelineQueryOptions } from "~/lib/queries";

export const Route = createFileRoute("/")({
  staticData: {
    wsMode: "input-surface",
  },
  head: () => ({
    meta: [{ title: "Autonoma — Input Surface" }],
  }),
  loader: async ({ context }) => {
    try {
      await context.queryClient.ensureQueryData(inputSurfaceTimelineQueryOptions());
    } catch {
      // Leave cache unseeded; component falls back to empty array.
    }
  },
  component: InputSurfacePage,
});

function InputSurfacePage() {
  useWhyDidYouRender("InputSurfacePage", {});
  return <InputSurface />;
}
