import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useRouterState } from "@tanstack/react-router";
import { statusQueryOptions } from "~/lib/queries";
import type { ConnectionState, WorkstreamSummary } from "~/lib/types";
import { cn } from "~/lib/utils";

function NavItem({ to, label, icon }: { to: string; label: string; icon: React.ReactNode }) {
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

function StatusDot({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", color)} />
      <span className="text-xs text-sidebar-foreground/50 shrink-0">{label}</span>
      <span className="text-xs text-sidebar-foreground/80 truncate">{value}</span>
    </div>
  );
}

/* Simple inline SVG icons — no dependency needed */
const icons = {
  inputSurface: (
    <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
      <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h11A1.5 1.5 0 0 1 15 3.5v1A1.5 1.5 0 0 1 13.5 6h-11A1.5 1.5 0 0 1 1 4.5v-1ZM1 8.5A1.5 1.5 0 0 1 2.5 7h11A1.5 1.5 0 0 1 15 8.5v1A1.5 1.5 0 0 1 13.5 11h-11A1.5 1.5 0 0 1 1 9.5v-1ZM2.5 12A1.5 1.5 0 0 0 1 13.5v.5h14v-.5a1.5 1.5 0 0 0-1.5-1.5h-11Z" />
    </svg>
  ),
  piAgent: (
    <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
      <path d="M2 3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H5.5L3 13.5V11H3a1 1 0 0 1-1-1V3Z" />
    </svg>
  ),
  sessions: (
    <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
      <path d="M0 3a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V3Zm2 0v2h12V3H2Zm0 4v6h12V7H2Z" />
    </svg>
  ),
  runtime: (
    <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
      <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 2.5a1 1 0 0 1 1 1V8l2.15 1.28a1 1 0 1 1-1.03 1.72l-2.62-1.57A1 1 0 0 1 7 8.5v-4a1 1 0 0 1 1-1Z" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
      <path
        fillRule="evenodd"
        d="M7.429 1.525a3.5 3.5 0 0 1 1.142 0 .75.75 0 0 1 .618.55l.31 1.16c.136.07.267.148.392.232l1.157-.35a.75.75 0 0 1 .79.29 5.5 5.5 0 0 1 .572.99.75.75 0 0 1-.172.84l-.847.81c.006.14.006.282 0 .423l.847.81a.75.75 0 0 1 .172.84 5.5 5.5 0 0 1-.572.99.75.75 0 0 1-.79.29l-1.157-.35a4 4 0 0 1-.392.232l-.31 1.16a.75.75 0 0 1-.618.55 3.5 3.5 0 0 1-1.142 0 .75.75 0 0 1-.618-.55l-.31-1.16a4 4 0 0 1-.392-.232l-1.157.35a.75.75 0 0 1-.79-.29 5.5 5.5 0 0 1-.572-.99.75.75 0 0 1 .172-.84l.847-.81a4 4 0 0 1 0-.423l-.847-.81a.75.75 0 0 1-.172-.84 5.5 5.5 0 0 1 .572-.99.75.75 0 0 1 .79-.29l1.157.35c.125-.084.256-.162.392-.232l.31-1.16a.75.75 0 0 1 .618-.55ZM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"
      />
    </svg>
  ),
};

function connectionColor(state: ConnectionState): string {
  switch (state) {
    case "connected":
      return "bg-emerald-500";
    case "connecting":
    case "reconnecting":
      return "bg-amber-500";
    case "stub":
      return "bg-blue-500";
    default:
      return "bg-zinc-500";
  }
}

export function Sidebar({
  connectionState,
  onOpenSettings,
}: {
  connectionState: ConnectionState;
  onOpenSettings: () => void;
}) {
  const rootApi = getRouteApi("__root__");
  const { apiClient } = rootApi.useRouteContext();

  const statusQuery = useQuery({
    ...statusQueryOptions(apiClient),
    retry: 1,
  });

  const status = statusQuery.data;
  const piState = status?.pi?.default?.busy ? "active" : "idle";
  const waStatus = status?.whatsapp.status ?? "unknown";
  const allWorkstreams = status?.workstreams ?? [];
  const openWorkstreams = allWorkstreams.filter((ws: WorkstreamSummary) => ws.status === "open");
  const closedWorkstreams = allWorkstreams.filter(
    (ws: WorkstreamSummary) => ws.status === "closed",
  );

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

      {/* Status cluster */}
      <div className="shrink-0 px-4 py-3 space-y-1.5 border-b border-sidebar-border">
        <StatusDot
          color={piState === "active" ? "bg-emerald-500" : "bg-blue-400"}
          label="Pi"
          value={piState}
        />
        <StatusDot
          color={
            waStatus === "connected"
              ? "bg-emerald-500"
              : waStatus === "stopped" || waStatus === "disabled"
                ? "bg-zinc-500"
                : "bg-amber-500"
          }
          label="WA"
          value={waStatus}
        />
        <StatusDot color={connectionColor(connectionState)} label="WS" value={connectionState} />
      </div>

      {/* Navigation */}
      <nav className="shrink-0 px-3 py-3 space-y-0.5">
        <NavItem to="/" label="Input Surface" icon={icons.inputSurface} />
        <NavItem to="/pi" label="Pi Agent" icon={icons.piAgent} />
        <NavItem to="/sessions" label="Claude Code" icon={icons.sessions} />
        <NavItem to="/runtime" label="Runtime" icon={icons.runtime} />
      </nav>

      {/* Workstreams */}
      {allWorkstreams.length > 0 && (
        <div className="px-4 py-3 border-t border-sidebar-border flex-1 min-h-0 overflow-y-auto">
          {openWorkstreams.length > 0 && (
            <>
              <p className="text-[10px] uppercase tracking-wider text-sidebar-foreground/40 font-medium mb-2">
                Active workstreams
              </p>
              <div className="space-y-1">
                {openWorkstreams
                  .filter((ws) => ws.piSessionId)
                  .map((ws) => (
                    <Link
                      key={ws.id}
                      to="/pi/$sessionId"
                      params={{ sessionId: ws.piSessionId! }}
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

          {closedWorkstreams.length > 0 && (
            <div className={openWorkstreams.length > 0 ? "mt-3" : ""}>
              <p className="text-[10px] uppercase tracking-wider text-sidebar-foreground/30 font-medium mb-2">
                Recently closed
              </p>
              <div className="space-y-1">
                {closedWorkstreams
                  .filter((ws) => ws.piSessionId)
                  .map((ws) => (
                    <Link
                      key={ws.id}
                      to="/pi/$sessionId"
                      params={{ sessionId: ws.piSessionId! }}
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
      {allWorkstreams.length === 0 && <div className="flex-1" />}

      {/* Settings trigger */}
      <div className="shrink-0 px-3 py-3 border-t border-sidebar-border">
        <button
          onClick={onOpenSettings}
          className={cn(
            "flex items-center gap-3 rounded-lg px-3 py-2 text-sm w-full transition-colors",
            "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
          )}
        >
          <span className="shrink-0 w-4 h-4 flex items-center justify-center">
            {icons.settings}
          </span>
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}
