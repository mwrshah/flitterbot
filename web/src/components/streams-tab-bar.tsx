import { useQuery } from "@tanstack/react-query";
import { Link, getRouteApi, useRouterState } from "@tanstack/react-router";

import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { statusQueryOptions } from "~/lib/queries";
import { cn } from "~/lib/utils";

const streamsRouteApi = getRouteApi("/streams");

export function StreamsTabBar() {
  useWhyDidYouRender("StreamsTabBar", {});
  const { apiClient } = streamsRouteApi.useRouteContext();

  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const statusQuery = useQuery({
    ...statusQueryOptions(apiClient),
    retry: 1,
  });

  const allOrchestrators = statusQuery.data?.piAgent?.orchestrators ?? [];
  const streams = statusQuery.data?.streams ?? [];

  const openStreamIds = new Set(streams.filter((w) => w.status === "open").map((w) => w.id));
  const openOrchestrators = allOrchestrators.filter((o) => openStreamIds.has(o.streamId));

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
  );
}

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
