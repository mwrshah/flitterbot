import { createFileRoute } from "@tanstack/react-router";
import { InputSurface } from "~/components/input-surface/InputSurface";
import type { ChatTimelineItem } from "~/lib/types";
import { fetchPiInputHistory } from "~/server/pi";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [{ title: "Autonoma — Input Surface" }],
  }),
  loader: async () => {
    try {
      const items = await fetchPiInputHistory();
      return { history: items as ChatTimelineItem[] };
    } catch {
      return { history: [] as ChatTimelineItem[] };
    }
  },
  component: InputSurfacePage,
});

function InputSurfacePage() {
  const { history } = Route.useLoaderData();
  return <InputSurface loaderTimeline={history} />;
}
