import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useRouterState } from "@tanstack/react-router";
import { PinIcon, PinOffIcon, PlusIcon } from "lucide-react";
import { memo, type ReactElement, type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import logoBlack from "~/assets/flitterbot_logo_black_small.png";
import logoWhite from "~/assets/flitterbot_logo_white_small.png";
import { ShortcutHint } from "~/components/common/kbd";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "~/components/ui/context-menu";
import { useModifierLabel } from "~/hooks/platform";
import { useCreateSwimlane } from "~/hooks/use-create-swimlane";
import { useLastStreamPath } from "~/hooks/use-last-stream-path";
import { useReopenStream } from "~/hooks/use-reopen-stream";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import {
  registerShortcutHandlers,
  SHORTCUT_ACTIONS,
  useShortcutBindingLabel,
} from "~/lib/global-shortcuts";
import { statusQueryOptions } from "~/lib/queries";
import { getStreamRecoveryKind } from "~/lib/stream-recovery";
import type { PiSessionStatus, StreamSummary } from "~/lib/types";
import { cn } from "~/lib/utils";

function piStatusDotClass(status: PiSessionStatus | undefined): string {
  switch (status) {
    case "active":
      return "bg-status-active";
    case "waiting_for_sessions":
      return "bg-status-supervising";
    case "waiting_for_user":
      return "bg-status-waiting";
    case "crashed":
      return "bg-status-crashed";
    default:
      return "bg-status-ended";
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
          ? "bg-background-selected text-text"
          : "text-text-muted hover:bg-background-hover hover:text-text",
      )}
    >
      <span className="shrink-0 size-4 flex items-center justify-center">{icon}</span>
      <span className="truncate">{label}</span>
      {shortcutHint && <ShortcutHint label={shortcutHint} className="ml-auto" kbdSize="compact" />}
    </Link>
  );
}

function StreamContextMenu({
  name,
  pinned,
  disabled,
  onTogglePinned,
  onRename,
  onReopen,
  onClose,
  renderTrigger,
}: {
  name: string;
  pinned?: boolean;
  disabled: boolean;
  onTogglePinned?: () => void;
  onRename?: (name: string) => void;
  onReopen?: () => void;
  onClose?: () => void;
  renderTrigger: (label: ReactNode) => ReactElement;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusSettledRef = useRef(false);

  useEffect(() => {
    if (!editing) return;
    focusSettledRef.current = false;
    const raf = requestAnimationFrame(() => {
      const input = inputRef.current;
      input?.focus();
      input?.setSelectionRange(0, input.value.length, "backward");
      if (input) input.scrollLeft = 0;
      focusSettledRef.current = true;
    });
    return () => cancelAnimationFrame(raf);
  }, [editing]);

  const commit = () => {
    if (!focusSettledRef.current) return;
    setEditing(false);
    const trimmed = value.trim();
    if (trimmed && trimmed !== name) {
      onRename?.(trimmed);
    } else {
      setValue(name);
    }
  };

  const label = editing ? (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          inputRef.current?.blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setValue(name);
          setEditing(false);
        }
      }}
      onClick={(e) => e.preventDefault()}
      className="min-w-0 flex-1 select-text border-0 bg-transparent outline-none shadow-[inset_0_-1px_0_var(--border)] focus:shadow-[inset_0_-1px_0_var(--border-pop)]"
    />
  ) : (
    <span className="truncate flex-1">{name}</span>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={renderTrigger(label)}
        onClick={(e) => {
          if (e.detail > 1) e.preventDefault();
        }}
        onDoubleClick={(e) => {
          e.preventDefault();
          if (!onRename) return;
          setValue(name);
          setEditing(true);
        }}
      />
      <ContextMenuContent>
        <ContextMenuItem
          disabled={!onRename}
          onClick={() => {
            setValue(name);
            setEditing(true);
          }}
        >
          Rename
        </ContextMenuItem>
        <ContextMenuItem disabled={disabled || !onTogglePinned} onClick={onTogglePinned}>
          {pinned ? "Unpin" : "Pin"}
        </ContextMenuItem>
        <ContextMenuItem disabled={disabled || !onReopen} onClick={onReopen}>
          Reopen
        </ContextMenuItem>
        <ContextMenuItem disabled={disabled || !onClose} onClick={onClose}>
          Close
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
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
  const { apiClient } = rootApi.useRouteContext();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  useEffect(() => setQuery(""), [pathname]);

  useEffect(
    () =>
      registerShortcutHandlers([
        {
          actionId: SHORTCUT_ACTIONS.swimlaneSearch,
          handler: () => {
            const input = searchInputRef.current;
            if (!input) return false;
            input.focus();
            return true;
          },
        },
      ]),
    [],
  );

  const statusQuery = useQuery({
    ...statusQueryOptions(apiClient),
    retry: 1,
  });

  const pinStreamMutation = useMutation({
    mutationFn: ({ streamId, pinned }: { streamId: string; pinned: boolean }) =>
      apiClient.setStreamPinned(streamId, pinned),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["status"] });
    },
    onError: (error) => {
      toast.error(
        `Failed to update swimlane pin: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });

  const renameStreamMutation = useMutation({
    mutationFn: ({ streamId, name }: { streamId: string; name: string }) =>
      apiClient.setStreamName(streamId, name),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["status"] });
    },
    onError: (error) => {
      toast.error(
        `Failed to rename swimlane: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });

  const closeSwimlaneMutation = useMutation({
    mutationFn: (streamId: string) => apiClient.closeSwimlane(streamId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["status"] });
    },
    onError: (error) => {
      toast.error(
        `Failed to close swimlane: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });

  const createSwimlaneMutation = useCreateSwimlane();
  const reopenStreamMutation = useReopenStream();

  const status = statusQuery.data;
  const defaultPiSessionId = status?.piAgent?.default?.piSessionId;
  const allStreams = status?.streams ?? [];
  const openStreams: StreamSummary[] = [];
  const closedStreams: StreamSummary[] = [];
  for (const stream of allStreams) {
    if (stream.status === "open") openStreams.push(stream);
    if (stream.status === "closed") closedStreams.push(stream);
  }

  const normalizedQuery = query.trim().toLowerCase();
  const filteredOpenStreams = normalizedQuery
    ? openStreams.filter((s) => s.name.toLowerCase().includes(normalizedQuery))
    : openStreams;
  const filteredClosedStreams = normalizedQuery
    ? closedStreams.filter((s) => s.name.toLowerCase().includes(normalizedQuery))
    : closedStreams;
  const showDefaultStream =
    !!defaultPiSessionId && (!normalizedQuery || "flitterbot".includes(normalizedQuery));

  let nextShortcut = 1;
  const defaultShortcut = defaultPiSessionId && nextShortcut <= 9 ? nextShortcut++ : null;
  const streamShortcuts = new Map<string, number>();
  for (const ws of openStreams) {
    if (ws.piSessionId && nextShortcut <= 9) {
      streamShortcuts.set(ws.id, nextShortcut++);
    }
  }
  const currentPiSessionId = pathname.startsWith("/streams/") ? pathname.split("/")[2] : null;
  const surfaceShortcutHint = useShortcutBindingLabel(SHORTCUT_ACTIONS.navSurface, {
    altLabel: mod,
  });
  const streamsShortcutHint = useShortcutBindingLabel(SHORTCUT_ACTIONS.navLastStream, {
    altLabel: mod,
  });
  const newSwimlaneShortcutHint = useShortcutBindingLabel(SHORTCUT_ACTIONS.swimlaneCreate, {
    altLabel: mod,
  });

  return (
    <aside className="flex h-full min-h-0 select-none flex-col overflow-hidden border-r border-border bg-background">
      <nav className="shrink-0 p-3 space-y-0.5">
        <NavItem to="/" label="Surface" icon={icons.surface} shortcutHint={surfaceShortcutHint} />
        <NavItem
          to={lastStreamPath}
          label="Swimlanes"
          icon={
            <>
              <img src={logoBlack} alt="" className="size-4 object-contain dark:hidden" />
              <img src={logoWhite} alt="" className="size-4 object-contain hidden dark:block" />
            </>
          }
          shortcutHint={streamsShortcutHint}
        />
      </nav>

      {(defaultPiSessionId || allStreams.length > 0) && (
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-border pb-3 pl-3 pr-2 pt-2">
          <div className="flex items-center justify-between mb-0.5">
            <div className="-ml-1 flex h-6 min-w-0 flex-1 items-center">
              <input
                ref={searchInputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  event.stopPropagation();
                  setQuery("");
                  event.currentTarget.blur();
                }}
                placeholder="SEARCH SWIMLANES"
                aria-label="Search swimlanes by name"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                className="h-full min-w-0 flex-1 border-0 bg-transparent px-1 py-0 text-[10px] font-medium leading-4 text-text outline-none placeholder:font-medium placeholder:uppercase placeholder:tracking-wider placeholder:text-text-muted focus:shadow-[inset_0_-1px_0_var(--border-pop)] focus:placeholder:opacity-0"
              />
            </div>
            <div
              className="group pl-4 pr-3 pb-2 -mr-2 -mb-2"
              onClick={() => {
                if (!createSwimlaneMutation.isPending) createSwimlaneMutation.mutate();
              }}
            >
              <button
                type="button"
                disabled={createSwimlaneMutation.isPending}
                aria-label="New swimlane"
                title={
                  newSwimlaneShortcutHint
                    ? `New swimlane (${newSwimlaneShortcutHint})`
                    : "New swimlane"
                }
                className="flex size-6 items-center justify-center rounded text-sm leading-none text-text-muted transition-colors group-hover:bg-background-hover group-hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
              >
                <PlusIcon className="size-3" aria-hidden />
              </button>
            </div>
          </div>

          {(showDefaultStream || filteredOpenStreams.length > 0) && (
            <div>
              {showDefaultStream && (
                <StreamContextMenu
                  name="flitterbot"
                  disabled={pinStreamMutation.isPending || reopenStreamMutation.isPending}
                  renderTrigger={() => (
                    <Link
                      to="/streams/$piSessionId"
                      params={{ piSessionId: defaultPiSessionId }}
                      // hovering a stream must not fetch its history
                      preload={false}
                      className={cn(
                        "group flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors",
                        currentPiSessionId === defaultPiSessionId ||
                          (pathname === "/streams" && !currentPiSessionId)
                          ? "bg-background-selected text-text"
                          : "text-text-muted hover:bg-background-hover hover:text-text data-popup-open:bg-background-hover data-popup-open:text-text",
                      )}
                    >
                      <span
                        className={cn(
                          "shrink-0 size-2 rounded-full",
                          status?.piAgent?.default?.busy ? "bg-status-active" : "bg-status-ended",
                        )}
                      />
                      <span className="truncate flex-1">flitterbot</span>
                      {defaultShortcut && (
                        <ShortcutHint
                          label={String(defaultShortcut)}
                          className="ml-2 shrink-0"
                          kbdSize="compact"
                        />
                      )}
                    </Link>
                  )}
                />
              )}
              {filteredOpenStreams.map((ws) => {
                const piSessionId = ws.piSessionId;
                const recoveryKind = getStreamRecoveryKind(ws);
                const onReopen = recoveryKind
                  ? () => reopenStreamMutation.mutate({ streamId: ws.id, recoveryKind })
                  : undefined;

                return piSessionId ? (
                  <StreamContextMenu
                    key={ws.id}
                    name={ws.name}
                    pinned={ws.pinned}
                    disabled={pinStreamMutation.isPending || reopenStreamMutation.isPending}
                    onTogglePinned={() =>
                      pinStreamMutation.mutate({ streamId: ws.id, pinned: !ws.pinned })
                    }
                    onRename={(name) => renameStreamMutation.mutate({ streamId: ws.id, name })}
                    onReopen={onReopen}
                    onClose={() => closeSwimlaneMutation.mutate(ws.id)}
                    renderTrigger={(label) => (
                      <Link
                        to="/streams/$piSessionId"
                        params={{ piSessionId }}
                        // hovering a stream must not fetch its history
                        preload={false}
                        className={cn(
                          "group flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors",
                          currentPiSessionId === piSessionId
                            ? "bg-background-selected text-text"
                            : "text-text-muted hover:bg-background-hover hover:text-text data-popup-open:bg-background-hover data-popup-open:text-text",
                        )}
                      >
                        <span
                          className={cn(
                            "shrink-0 size-2 rounded-full",
                            piStatusDotClass(ws.piSessionStatus),
                          )}
                        />
                        {label}
                        {streamShortcuts.has(ws.id) && (
                          <ShortcutHint
                            label={String(streamShortcuts.get(ws.id))}
                            className={cn("ml-2 shrink-0", ws.pinned && "group-hover:hidden")}
                            kbdSize="compact"
                          />
                        )}
                        {ws.pinned && (
                          <button
                            type="button"
                            aria-label="Unpin swimlane"
                            className={cn(
                              "group/pin ml-2 mr-0.5 hidden size-3 shrink-0 items-center justify-center text-text-muted hover:text-text group-hover:flex",
                              !streamShortcuts.has(ws.id) && "ml-auto",
                            )}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              pinStreamMutation.mutate({ streamId: ws.id, pinned: false });
                            }}
                          >
                            <PinIcon className="size-3 group-hover/pin:hidden" />
                            <PinOffIcon className="hidden size-3 group-hover/pin:block" />
                          </button>
                        )}
                      </Link>
                    )}
                  />
                ) : (
                  <StreamContextMenu
                    key={ws.id}
                    name={ws.name}
                    pinned={ws.pinned}
                    disabled={pinStreamMutation.isPending || reopenStreamMutation.isPending}
                    onTogglePinned={() =>
                      pinStreamMutation.mutate({ streamId: ws.id, pinned: !ws.pinned })
                    }
                    onRename={(name) => renameStreamMutation.mutate({ streamId: ws.id, name })}
                    onReopen={onReopen}
                    onClose={() => closeSwimlaneMutation.mutate(ws.id)}
                    renderTrigger={(label) => (
                      <div className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text-muted">
                        <span className={cn("shrink-0 size-2 rounded-full", "bg-status-ended")} />
                        {label}
                        {ws.pinned && (
                          <button
                            type="button"
                            aria-label="Unpin swimlane"
                            className="group/pin ml-auto mr-0.5 hidden size-3 shrink-0 items-center justify-center text-text-muted hover:text-text group-hover:flex"
                            onClick={() => {
                              pinStreamMutation.mutate({ streamId: ws.id, pinned: false });
                            }}
                          >
                            <PinIcon className="size-3 group-hover/pin:hidden" />
                            <PinOffIcon className="hidden size-3 group-hover/pin:block" />
                          </button>
                        )}
                      </div>
                    )}
                  />
                );
              })}
            </div>
          )}

          {filteredClosedStreams.length > 0 && (
            <div className={showDefaultStream || filteredOpenStreams.length > 0 ? "mt-6" : ""}>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-muted">
                Recently closed
              </p>
              <div>
                {filteredClosedStreams.map((ws) => {
                  const piSessionId = ws.piSessionId;
                  const recoveryKind = getStreamRecoveryKind(ws);
                  const onReopen = recoveryKind
                    ? () => reopenStreamMutation.mutate({ streamId: ws.id, recoveryKind })
                    : undefined;

                  return piSessionId ? (
                    <StreamContextMenu
                      key={ws.id}
                      name={ws.name}
                      pinned={ws.pinned}
                      disabled={pinStreamMutation.isPending || reopenStreamMutation.isPending}
                      onTogglePinned={() =>
                        pinStreamMutation.mutate({ streamId: ws.id, pinned: !ws.pinned })
                      }
                      onRename={(name) => renameStreamMutation.mutate({ streamId: ws.id, name })}
                      onReopen={onReopen}
                      renderTrigger={(label) => (
                        <Link
                          to="/streams/$piSessionId"
                          params={{ piSessionId }}
                          // hovering a stream must not fetch its history
                          preload={false}
                          className={cn(
                            "group flex items-center justify-between px-2 py-1.5 rounded-md text-sm transition-colors",
                            currentPiSessionId === piSessionId
                              ? "bg-background-selected text-text"
                              : "text-text-muted hover:bg-background-hover hover:text-text data-popup-open:bg-background-hover data-popup-open:text-text",
                          )}
                        >
                          {label}
                          {ws.pinned && (
                            <button
                              type="button"
                              aria-label="Unpin swimlane"
                              className="group/pin ml-2 mr-0.5 flex size-3 shrink-0 items-center justify-center text-text-muted hover:text-text"
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                pinStreamMutation.mutate({ streamId: ws.id, pinned: false });
                              }}
                            >
                              <PinIcon className="size-3 group-hover/pin:hidden" />
                              <PinOffIcon className="hidden size-3 group-hover/pin:block" />
                            </button>
                          )}
                        </Link>
                      )}
                    />
                  ) : null;
                })}
              </div>
            </div>
          )}

          {normalizedQuery &&
            !showDefaultStream &&
            filteredOpenStreams.length === 0 &&
            filteredClosedStreams.length === 0 && (
              <p className="ml-2 mt-2 text-[11px] text-text-muted">
                No swimlanes match “{query.trim()}”.
              </p>
            )}
        </div>
      )}

      {!defaultPiSessionId && allStreams.length === 0 && <div className="flex-1" />}
    </aside>
  );
});
