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
    // prefetchQuery starts the skills fetch in parallel with timeline data without
    // blocking navigation — prevents component-level waterfall for non-critical data.
    // See: features/tanstack-patterns/references/external-data-loading.md (lines 39-43)
    context.queryClient.prefetchQuery({
      queryKey: ["skills"],
      queryFn: () => context.apiClient.listSkills(),
      staleTime: 5 * 60 * 1000,
    });

    // No try/catch — let the route error boundary handle failures so
    // useSuspenseQuery in Surface works correctly with the loader.
    // See: features/tanstack-patterns/references/data-loading.md (lines 14-29)
    await context.queryClient.ensureQueryData(surfaceTimelineQueryOptions());
  },
  component: SurfacePage,
});

function SurfacePage() {
  useWhyDidYouRender("SurfacePage", {});
  return <Surface />;
}
