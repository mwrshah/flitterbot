import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { Badge } from "~/components/ui/badge";
import { statusQueryOptions } from "~/lib/queries";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/pi")({
  head: () => ({
    meta: [{ title: "Autonoma — Pi Agent" }],
  }),
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(statusQueryOptions(context.apiClient));
  },
  errorComponent: ({ error }) => (
    <div className="flex items-center justify-center h-full p-8 text-destructive">
      <p>Failed to load Pi status: {String(error)}</p>
    </div>
  ),
  component: PiLayoutRoute,
});

/* ── Layout component ── */

function PiLayoutRoute() {
  const { apiClient, wsClient } = Route.useRouteContext();

  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Status query — seeded by loader, invalidated via WebSocket (listener in root route)
  const statusQuery = useQuery({
    ...statusQueryOptions(apiClient),
    retry: 1,
  });

  const allOrchestrators = statusQuery.data?.pi?.orchestrators ?? [];
  const defaultPi = statusQuery.data?.pi?.default;
  const workstreams = statusQuery.data?.workstreams ?? [];

  // Build set of open workstream IDs
  const openWsIds = new Set(workstreams.filter((w) => w.status === "open").map((w) => w.id));

  // Persistent tabs: only orchestrators with open workstreams
  const openOrchestrators = allOrchestrators.filter((o) => openWsIds.has(o.workstreamId));

  // Ephemeral tab: if current URL points to a closed workstream's orchestrator, include it
  const currentSessionId = pathname.startsWith("/pi/") ? pathname.split("/")[2] : null;
  const ephemeralOrchestrator =
    currentSessionId && currentSessionId !== "default"
      ? allOrchestrators.find(
          (o) => o.sessionId === currentSessionId && !openWsIds.has(o.workstreamId),
        )
      : undefined;

  const orchestrators = ephemeralOrchestrator
    ? [...openOrchestrators, ephemeralOrchestrator]
    : openOrchestrators;

  // Subscribe to default agent + all orchestrator sessions
  const defaultSessionId = defaultPi?.sessionId;
  useEffect(() => {
    const sessionIds = allOrchestrators.map((o) => o.sessionId);
    if (defaultSessionId) {
      sessionIds.push(defaultSessionId);
    }
    for (const id of sessionIds) {
      wsClient.subscribeSession(id);
    }
    return () => {
      for (const id of sessionIds) {
        wsClient.unsubscribeSession(id);
      }
    };
  }, [wsClient, defaultSessionId, allOrchestrators.map((o) => o.sessionId).join(",")]);

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-border shrink-0 overflow-x-auto">
        <TabLink to="/pi/default" active={pathname === "/pi/default" || pathname === "/pi"}>
          Default
          {defaultPi?.busy && <Badge variant="success">active</Badge>}
        </TabLink>
        {orchestrators.map((o) => (
          <TabLink
            key={o.sessionId}
            to={`/pi/${o.sessionId}`}
            active={pathname === `/pi/${o.sessionId}`}
          >
            {o.workstreamName ?? o.workstreamId}
            {o.busy && <Badge variant="success">active</Badge>}
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
