import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useRouterState } from "@tanstack/react-router";
import { memo } from "react";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { statusQueryOptions } from "~/lib/queries";
import type { StreamSummary } from "~/lib/types";
import { cn } from "~/lib/utils";

function NavItem({ to, label, icon }: { to: string; label: string; icon: React.ReactNode }) {
  useWhyDidYouRender("NavItem", { to, label, icon });
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const active = to === "/" ? pathname === "/" : pathname.startsWith(to);

  return (
    <Link
      to={to}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
      )}
    >
      <span className="shrink-0 w-4 h-4 flex items-center justify-center">{icon}</span>
      <span className="truncate">{label}</span>
    </Link>
  );
}

const icons = {
  surface: (
    <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
      <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h11A1.5 1.5 0 0 1 15 3.5v1A1.5 1.5 0 0 1 13.5 6h-11A1.5 1.5 0 0 1 1 4.5v-1ZM1 8.5A1.5 1.5 0 0 1 2.5 7h11A1.5 1.5 0 0 1 15 8.5v1A1.5 1.5 0 0 1 13.5 11h-11A1.5 1.5 0 0 1 1 9.5v-1ZM2.5 12A1.5 1.5 0 0 0 1 13.5v.5h14v-.5a1.5 1.5 0 0 0-1.5-1.5h-11Z" />
    </svg>
  ),
  streamAgent: (
    <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
      <path d="M2 3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H5.5L3 13.5V11H3a1 1 0 0 1-1-1V3Z" />
    </svg>
  ),
};

export const Sidebar = memo(function Sidebar() {
  useWhyDidYouRender("Sidebar", {});
  const rootApi = getRouteApi("__root__");
  const { apiClient } = rootApi.useRouteContext();

  const statusQuery = useQuery({
    ...statusQueryOptions(apiClient),
    retry: 1,
  });

  const status = statusQuery.data;
  const allStreams = status?.streams ?? [];
  const openStreams = allStreams.filter((ws: StreamSummary) => ws.status === "open");
  const closedStreams = allStreams.filter((ws: StreamSummary) => ws.status === "closed");

  return (
    <aside className="flex flex-col h-full bg-sidebar border-r border-sidebar-border">
      {/* Brand */}
      <div className="shrink-0 px-4 py-4 border-b border-sidebar-border">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-sidebar-primary flex items-center justify-center">
            <span className="text-xs font-bold text-sidebar-primary-foreground">A</span>
          </div>
          <span className="text-sm font-semibold text-sidebar-foreground">Autonoma</span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="shrink-0 px-3 py-3 space-y-0.5">
        <NavItem to="/" label="Surface" icon={icons.surface} />
        <NavItem to="/streams" label="Streams" icon={icons.streamAgent} />
      </nav>

      {/* Streams */}
      {allStreams.length > 0 && (
        <div className="px-4 py-3 border-t border-sidebar-border flex-1 min-h-0 overflow-y-auto">
          {openStreams.length > 0 && (
            <>
              <p className="text-[10px] uppercase tracking-wider text-sidebar-foreground/40 font-medium mb-2">
                Active streams
              </p>
              <div className="space-y-1">
                {openStreams
                  .filter((ws) => ws.streamSessionId)
                  .map((ws) => (
                    <Link
                      key={ws.id}
                      to="/streams/$sessionId"
                      params={{ sessionId: ws.streamSessionId! }}
                      className="flex items-center justify-between px-2 py-1.5 rounded-md text-xs text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground transition-colors"
                    >
                      <span className="truncate">{ws.name}</span>
                      <span className="text-sidebar-foreground/40 tabular-nums shrink-0 ml-2">
                        {ws.sessionCount}
                      </span>
                    </Link>
                  ))}
              </div>
            </>
          )}

          {closedStreams.length > 0 && (
            <div className={openStreams.length > 0 ? "mt-3" : ""}>
              <p className="text-[10px] uppercase tracking-wider text-sidebar-foreground/30 font-medium mb-2">
                Recently closed
              </p>
              <div className="space-y-1">
                {closedStreams
                  .filter((ws) => ws.streamSessionId)
                  .map((ws) => (
                    <Link
                      key={ws.id}
                      to="/streams/$sessionId"
                      params={{ sessionId: ws.streamSessionId! }}
                      className="flex items-center justify-between px-2 py-1.5 rounded-md text-xs text-sidebar-foreground/30 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground/50 transition-colors"
                    >
                      <span className="truncate">{ws.name}</span>
                      <span className="text-sidebar-foreground/20 tabular-nums shrink-0 ml-2">
                        {ws.sessionCount}
                      </span>
                    </Link>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Spacer */}
      {allStreams.length === 0 && <div className="flex-1" />}
    </aside>
  );
});
