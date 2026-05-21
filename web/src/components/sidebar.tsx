import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useRouterState } from "@tanstack/react-router";
import { memo } from "react";
import logoBlack from "~/assets/flitterbot_logo_black_small.png";
import logoWhite from "~/assets/flitterbot_logo_white_small.png";
import { ShortcutHint } from "~/components/common/kbd";
import { useModifierLabel } from "~/hooks/platform";
import { useLastStreamPath } from "~/hooks/use-last-stream-path";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { SHORTCUT_ACTIONS, useShortcutBindingLabel } from "~/lib/global-shortcuts";
import { statusQueryOptions } from "~/lib/queries";
import type { PiSessionStatus, StreamSummary } from "~/lib/types";
import { cn } from "~/lib/utils";

function piStatusDotClass(status: PiSessionStatus | undefined): string {
  switch (status) {
    case "active":
      return "bg-emerald-500 animate-pulse";
    case "waiting_for_sessions":
      return "bg-lime-400";
    case "waiting_for_user":
      return "bg-amber-500";
    case "crashed":
      return "bg-red-500";
    default:
      return "bg-zinc-500";
  }
}

function NavItem({
  to,
  label,
  icon,
  shortcutHint,
}: {
  to: string;
  label: string;
  icon: React.ReactNode;
  shortcutHint?: string;
}) {
  useWhyDidYouRender("NavItem", { to, label, icon, shortcutHint });
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const active = to === "/" ? pathname === "/" : pathname.startsWith(to);

  return (
    <Link
      to={to}
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
        active
          ? "bg-accent text-accent-foreground font-medium"
          : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
      )}
    >
      <span className="shrink-0 size-4 flex items-center justify-center">{icon}</span>
      <span className="truncate">{label}</span>
      {shortcutHint && (
        <ShortcutHint
          label={shortcutHint}
          className="ml-auto text-sidebar-foreground/30"
          kbdSize="compact"
          kbdTone="sidebar"
        />
      )}
    </Link>
  );
}

const icons = {
  surface: (
    <svg viewBox="0 0 16 16" fill="currentColor" className="size-4">
      <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h11A1.5 1.5 0 0 1 15 3.5v1A1.5 1.5 0 0 1 13.5 6h-11A1.5 1.5 0 0 1 1 4.5v-1ZM1 8.5A1.5 1.5 0 0 1 2.5 7h11A1.5 1.5 0 0 1 15 8.5v1A1.5 1.5 0 0 1 13.5 11h-11A1.5 1.5 0 0 1 1 9.5v-1ZM2.5 12A1.5 1.5 0 0 0 1 13.5v.5h14v-.5a1.5 1.5 0 0 0-1.5-1.5h-11Z" />
    </svg>
  ),
};

export const Sidebar = memo(function Sidebar() {
  const mod = useModifierLabel();
  const lastStreamPath = useLastStreamPath();
  useWhyDidYouRender("Sidebar", {});
  const rootApi = getRouteApi("__root__");
  const { apiClient, sendMessage } = rootApi.useRouteContext();

  const statusQuery = useQuery({
    ...statusQueryOptions(apiClient),
    retry: 1,
  });

  const status = statusQuery.data;
  const defaultPiSessionId = status?.piAgent?.default?.piSessionId;
  const allStreams = status?.streams ?? [];
  const openStreams: StreamSummary[] = [];
  const closedStreams: StreamSummary[] = [];
  for (const stream of allStreams) {
    if (stream.status === "open") openStreams.push(stream);
    if (stream.status === "closed") closedStreams.push(stream);
  }

  // Build shortcut index: default gets 1 (if present), then open streams with piSessionId
  let nextShortcut = 1;
  const defaultShortcut = defaultPiSessionId && nextShortcut <= 9 ? nextShortcut++ : null;
  const streamShortcuts = new Map<string, number>();
  for (const ws of openStreams) {
    if (ws.piSessionId && nextShortcut <= 9) {
      streamShortcuts.set(ws.id, nextShortcut++);
    }
  }
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const currentPiSessionId = pathname.startsWith("/streams/") ? pathname.split("/")[2] : null;
  const surfaceShortcutHint = useShortcutBindingLabel(SHORTCUT_ACTIONS.navSurface, {
    altLabel: mod,
  });
  const streamsShortcutHint = useShortcutBindingLabel(SHORTCUT_ACTIONS.navLastStream, {
    altLabel: mod,
  });

  return (
    <aside className="flex flex-col h-full bg-sidebar border-r border-sidebar-border">
      {/* Navigation */}
      <nav className="shrink-0 p-3 space-y-0.5">
        <NavItem to="/" label="Surface" icon={icons.surface} shortcutHint={surfaceShortcutHint} />
        <NavItem
          to={lastStreamPath}
          label="Streams"
          icon={
            <>
              <img src={logoBlack} alt="" className="size-4 object-contain dark:hidden" />
              <img src={logoWhite} alt="" className="size-4 object-contain hidden dark:block" />
            </>
          }
          shortcutHint={streamsShortcutHint}
        />
      </nav>

      {/* Streams */}
      {(defaultPiSessionId || allStreams.length > 0) && (
        <div className="pl-4 pr-3.5 py-3 border-t border-sidebar-border flex-1 min-h-0 overflow-y-auto">
          {(defaultPiSessionId || openStreams.length > 0) && (
            <>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] uppercase tracking-wider text-sidebar-foreground/40 font-medium">
                  Active streams
                </p>
                <button
                  type="button"
                  onClick={() => sendMessage("/new-stream").catch(() => {})}
                  aria-label="New stream"
                  className="size-4 flex items-center justify-center rounded text-sidebar-foreground/40 hover:text-sidebar-foreground hover:bg-sidebar-accent/50 transition-colors text-sm leading-none"
                >
                  +
                </button>
              </div>
              <div className="space-y-1">
                {defaultPiSessionId && (
                  <Link
                    to="/streams/$piSessionId"
                    params={{ piSessionId: defaultPiSessionId }}
                    className={cn(
                      "flex items-center gap-2 px-2 py-1.5 rounded-md text-xs transition-colors",
                      currentPiSessionId === defaultPiSessionId ||
                        (pathname === "/streams" && !currentPiSessionId)
                        ? "bg-accent text-accent-foreground font-medium"
                        : "text-sidebar-foreground/50 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                    )}
                  >
                    <span className="shrink-0 size-2 rounded-full bg-sidebar-foreground/25" />
                    <span className="truncate flex-1">flitterbot</span>
                    {defaultShortcut && (
                      <ShortcutHint
                        label={String(defaultShortcut)}
                        className="shrink-0 ml-2 text-sidebar-foreground/30"
                        kbdSize="compact"
                        kbdTone="sidebar"
                      />
                    )}
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
                          "shrink-0 size-2 rounded-full",
                          piStatusDotClass(ws.piSessionStatus),
                        )}
                      />
                      <span className="truncate flex-1">{ws.name}</span>
                      {streamShortcuts.has(ws.id) && (
                        <ShortcutHint
                          label={String(streamShortcuts.get(ws.id))}
                          className="shrink-0 ml-2 text-sidebar-foreground/30"
                          kbdSize="compact"
                          kbdTone="sidebar"
                        />
                      )}
                    </Link>
                  ) : (
                    <div
                      key={ws.id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-sidebar-foreground/40"
                    >
                      <span className={cn("shrink-0 size-2 rounded-full", "bg-zinc-500")} />
                      <span className="truncate flex-1">{ws.name}</span>
                    </div>
                  ),
                )}
              </div>
            </>
          )}

          {closedStreams.length > 0 && (
            <div className={defaultPiSessionId || openStreams.length > 0 ? "mt-6" : ""}>
              <p className="text-[10px] uppercase tracking-wider text-sidebar-foreground/30 font-medium mb-2">
                Recently closed
              </p>
              <div className="space-y-1">
                {closedStreams.map((ws) =>
                  ws.piSessionId ? (
                    <Link
                      key={ws.id}
                      to="/streams/$piSessionId"
                      params={{ piSessionId: ws.piSessionId }}
                      className={cn(
                        "flex items-center justify-between px-2 py-1.5 rounded-md text-xs transition-colors",
                        currentPiSessionId === ws.piSessionId
                          ? "bg-accent text-accent-foreground font-medium"
                          : "text-sidebar-foreground/30 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground/50",
                      )}
                    >
                      <span className="truncate">{ws.name}</span>
                    </Link>
                  ) : null,
                )}
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
