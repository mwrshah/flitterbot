import { createFileRoute } from "@tanstack/react-router";
import { InputSurface } from "~/components/input-surface";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import type { ChatTimelineItem } from "~/lib/types";
import { fetchPiInputHistory } from "~/server/pi";

export const Route = createFileRoute("/")({
  staticData: {
    wsMode: "input-surface",
  },
  head: () => ({
    meta: [{ title: "Autonoma — Input Surface" }],
  }),
  loader: async ({ context }) => {
    try {
      const items = await fetchPiInputHistory();
      const history = items as ChatTimelineItem[];
      // Seed the Query cache so useQuery returns instantly on mount.
      context.queryClient.setQueryData(["pi-input-surface-timeline"], history);
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
