import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useRouterState } from "@tanstack/react-router";
import { memo } from "react";
import logoBlack from "~/assets/autonoma_logo_black_small.png";
import logoWhite from "~/assets/autonoma_logo_white_small.png";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { statusQueryOptions } from "~/lib/queries";
import type { PiSessionStatus, StreamSummary } from "~/lib/types";
import { cn } from "~/lib/utils";

function piStatusDotClass(status: PiSessionStatus | undefined): string {
  switch (status) {
    case "active":
      return "bg-emerald-500 animate-pulse";
    case "waiting_for_sessions":
      return "bg-amber-500";
    case "waiting_for_user":
      return "bg-blue-400";
    default:
      return "bg-zinc-500";
  }
}

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
          ? "bg-accent text-accent-foreground font-medium"
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
  piAgent: (
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
  const defaultPiSessionId = status?.piAgent?.default?.piSessionId;
  const allStreams = status?.streams ?? [];
  const openStreams = allStreams.filter((ws: StreamSummary) => ws.status === "open");
  const closedStreams = allStreams.filter((ws: StreamSummary) => ws.status === "closed");
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const currentPiSessionId = pathname.startsWith("/streams/") ? pathname.split("/")[2] : null;

  return (
    <aside className="flex flex-col h-full bg-sidebar border-r border-sidebar-border">
      {/* Brand */}
      <div className="shrink-0 px-6 py-3 border-b border-sidebar-border">
        <div className="flex items-center gap-2">
          <img src={logoBlack} alt="Autonoma" className="w-6 h-6 dark:hidden" />
          <img src={logoWhite} alt="Autonoma" className="w-6 h-6 hidden dark:block" />
          <span className="text-sm font-semibold text-sidebar-foreground">Autonoma</span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="shrink-0 px-3 py-3 space-y-0.5">
        <NavItem to="/" label="Surface" icon={icons.surface} />
        <NavItem to="/streams" label="Streams" icon={icons.piAgent} />
      </nav>

      {/* Streams */}
      {(defaultPiSessionId || allStreams.length > 0) && (
        <div className="px-4 py-3 border-t border-sidebar-border flex-1 min-h-0 overflow-y-auto">
          {(defaultPiSessionId || openStreams.length > 0) && (
            <>
              <p className="text-[10px] uppercase tracking-wider text-sidebar-foreground/40 font-medium mb-2">
                Active streams
              </p>
              <div className="space-y-1">
                {defaultPiSessionId && (
                  <Link
                    to="/streams/default"
                    className={cn(
                      "flex items-center gap-2 px-2 py-1.5 rounded-md text-xs transition-colors",
                      currentPiSessionId === "default" ||
                        (pathname === "/streams" && !currentPiSessionId)
                        ? "bg-accent text-accent-foreground font-medium"
                        : "text-sidebar-foreground/50 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                    )}
                  >
                    <span className="shrink-0 h-2 w-2 rounded-full bg-sidebar-foreground/25" />
                    <span className="truncate flex-1">default</span>
                  </Link>
                )}
                {openStreams.map((ws) =>
                  ws.piSessionId ? (
                    <Link
                      key={ws.id}
                      to="/streams/$piSessionId"
                      params={{ piSessionId: ws.piSessionId }}
                      className={cn(
                        "flex items-center gap-2 px-2 py-1.5 rounded-md text-xs transition-colors",
                        currentPiSessionId === ws.piSessionId
                          ? "bg-accent text-accent-foreground font-medium"
                          : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                      )}
                    >
                      <span
                        className={cn(
                          "shrink-0 h-2 w-2 rounded-full",
                          piStatusDotClass(ws.piSessionStatus),
                        )}
                      />
                      <span className="truncate flex-1">{ws.name}</span>
                      <span className="text-sidebar-foreground/40 tabular-nums shrink-0 ml-2">
                        {ws.sessionCount}
                      </span>
                    </Link>
                  ) : (
                    <div
                      key={ws.id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-sidebar-foreground/40"
                    >
                      <span className={cn("shrink-0 h-2 w-2 rounded-full", "bg-zinc-500")} />
                      <span className="truncate flex-1">{ws.name}</span>
                      <span className="text-sidebar-foreground/20 tabular-nums shrink-0 ml-2">
                        {ws.sessionCount}
                      </span>
                    </div>
                  ),
                )}
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
                  .filter((ws) => ws.piSessionId)
                  .map((ws) => (
                    <Link
                      key={ws.id}
                      to="/streams/$piSessionId"
                      params={{ piSessionId: ws.piSessionId! }}
                      className={cn(
                        "flex items-center justify-between px-2 py-1.5 rounded-md text-xs transition-colors",
                        currentPiSessionId === ws.piSessionId
                          ? "bg-accent text-accent-foreground font-medium"
                          : "text-sidebar-foreground/30 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground/50",
                      )}
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
      {!defaultPiSessionId && allStreams.length === 0 && <div className="flex-1" />}
    </aside>
  );
});
