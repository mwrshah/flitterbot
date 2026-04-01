import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";

import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { statusQueryOptions } from "~/lib/queries";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/streams")({
  loader: async ({ context }) => {
    const t0 = performance.now();
    const queryState = context.queryClient.getQueryState(["status"]);
    console.log("[loader:/streams] START", {
      ts: new Date().toISOString(),
      hasStatusCache: !!queryState?.data,
      statusDataAge: queryState?.dataUpdatedAt ? `${(Date.now() - queryState.dataUpdatedAt).toFixed(0)}ms ago` : null,
    });
    await context.queryClient.ensureQueryData(statusQueryOptions(context.apiClient));
    console.log("[loader:/streams] END", { elapsed: `${(performance.now() - t0).toFixed(1)}ms` });
  },
  errorComponent: ({ error }) => (
    <div className="flex items-center justify-center h-full p-8 text-destructive">
      <p>Failed to load Streams status: {String(error)}</p>
    </div>
  ),
  component: StreamsLayoutRoute,
});

/* ── Layout component ── */

function StreamsLayoutRoute() {
  useWhyDidYouRender("StreamsLayoutRoute", {});
  const { apiClient } = Route.useRouteContext();

  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Status query — seeded by loader, invalidated via WebSocket (listener in root route)
  const statusQuery = useQuery({
    ...statusQueryOptions(apiClient),
    retry: 1,
  });

  const allOrchestrators = statusQuery.data?.piAgent?.orchestrators ?? [];
  const _defaultStreams = statusQuery.data?.piAgent?.default;
  const streams = statusQuery.data?.streams ?? [];

  // Build set of open stream IDs
  const openStreamIds = new Set(streams.filter((w) => w.status === "open").map((w) => w.id));

  // Persistent tabs: only orchestrators with open streams
  const openOrchestrators = allOrchestrators.filter((o) => openStreamIds.has(o.streamId));

  // Ephemeral tab: if current URL points to a closed stream's orchestrator, include it
  const currentPiSessionId = pathname.startsWith("/streams/") ? pathname.split("/")[2] : null;
  const ephemeralOrchestrator =
    currentPiSessionId && currentPiSessionId !== "default"
      ? allOrchestrators.find(
          (o) => o.piSessionId === currentPiSessionId && !openStreamIds.has(o.streamId),
        )
      : undefined;

  const orchestrators = ephemeralOrchestrator
    ? [...openOrchestrators, ephemeralOrchestrator]
    : openOrchestrators;

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex items-center gap-1 px-6 py-1.5 border-b border-border shrink-0 overflow-x-auto">
        <TabLink
          to="/streams/default"
          active={pathname === "/streams/default" || pathname === "/streams"}
        >
          default
        </TabLink>
        {orchestrators.map((o) => (
          <TabLink
            key={o.piSessionId}
            to={`/streams/${o.piSessionId}`}
            active={pathname === `/streams/${o.piSessionId}`}
          >
            {o.streamName ?? o.streamId}
          </TabLink>
        ))}
      </div>

      {/* Child route renders here */}
      <div className="flex-1 min-h-0">
        <Outlet />
      </div>
    </div>
  );
}

/* ── Tab link component ── */

function TabLink({
  to,
  active,
  children,
}: {
  to: string;
  active: boolean;
  children: React.ReactNode;
}) {
  useWhyDidYouRender("TabLink", { to, active });
  return (
    <Link
      to={to}
      className={cn(
        "flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap",
        active
          ? "bg-accent text-accent-foreground font-medium"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      {children}
    </Link>
  );
}
