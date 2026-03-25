import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { memo, useMemo } from "react";
import { Badge } from "~/components/ui/badge";
import { statusQueryOptions } from "~/lib/queries";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { cn } from "~/lib/utils";

type Orchestrator = { sessionId: string; workstreamId: string; workstreamName?: string; busy?: boolean };
type Workstream = { id: string; status: string };

const EMPTY_ORCHESTRATORS: Orchestrator[] = [];
const EMPTY_WORKSTREAMS: Workstream[] = [];

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
  const { apiClient } = Route.useRouteContext();

  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Status query — seeded by loader, invalidated via WebSocket (listener in root route)
  const statusQuery = useQuery({
    ...statusQueryOptions(apiClient),
    retry: 1,
  });

  const allOrchestrators = statusQuery.data?.pi?.orchestrators ?? EMPTY_ORCHESTRATORS;
  const defaultPi = statusQuery.data?.pi?.default;
  const workstreams = statusQuery.data?.workstreams ?? EMPTY_WORKSTREAMS;

  useWhyDidYouRender("PiLayoutRoute", { apiClient, pathname, allOrchestrators, defaultPi, workstreams });

  // Memoize orchestrators filtering — only recompute when inputs change
  const currentSessionId = pathname.startsWith("/pi/") ? pathname.split("/")[2] : null;

  const orchestrators = useMemo(() => {
    const openWsIds = new Set(workstreams.filter((w) => w.status === "open").map((w) => w.id));
    const openOrchestrators = allOrchestrators.filter((o) => openWsIds.has(o.workstreamId));

    const ephemeralOrchestrator =
      currentSessionId && currentSessionId !== "default"
        ? allOrchestrators.find(
            (o) => o.sessionId === currentSessionId && !openWsIds.has(o.workstreamId),
          )
        : undefined;

    return ephemeralOrchestrator
      ? [...openOrchestrators, ephemeralOrchestrator]
      : openOrchestrators;
  }, [allOrchestrators, workstreams, currentSessionId]);

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-border shrink-0 overflow-x-auto">
        <TabLink
          to="/pi/default"
          active={pathname === "/pi/default" || pathname === "/pi"}
          label="Default"
          busy={defaultPi?.busy}
        />
        {orchestrators.map((o) => (
          <TabLink
            key={o.sessionId}
            to={`/pi/${o.sessionId}`}
            active={pathname === `/pi/${o.sessionId}`}
            label={o.workstreamName ?? o.workstreamId}
            busy={o.busy}
          />
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

const TabLink = memo(function TabLink({
  to,
  active,
  label,
  busy,
}: {
  to: string;
  active: boolean;
  label: string;
  busy?: boolean;
}) {
  useWhyDidYouRender("TabLink", { to, active, label, busy });
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
      {label}
      {busy && <Badge variant="success">active</Badge>}
    </Link>
  );
});
