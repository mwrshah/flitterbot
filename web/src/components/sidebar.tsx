import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useRouterState } from "@tanstack/react-router";
import { PinIcon, PinOffIcon } from "lucide-react";
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
import { useCreateStream } from "~/hooks/use-create-stream";
import { useLastStreamPath } from "~/hooks/use-last-stream-path";
import { useReopenStream } from "~/hooks/use-reopen-stream";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { SHORTCUT_ACTIONS, useShortcutBindingLabel } from "~/lib/global-shortcuts";
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
          ? "bg-background-selected font-medium text-text"
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
  stream,
  disabled,
  onTogglePinned,
  onRename,
  onReopen,
  onClose,
  renderTrigger,
}: {
  stream: StreamSummary;
  disabled: boolean;
  onTogglePinned: () => void;
  onRename: (name: string) => void;
  onReopen?: () => void;
  onClose?: () => void;
  renderTrigger: (label: ReactNode) => ReactElement;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(stream.name);
  const inputRef = useRef<HTMLInputElement>(null);
  // Base UI restores focus to the trigger when the context menu closes, which
  // blurs the freshly-mounted input. Defer focusing past that restore and
  // ignore any blur fired before the input is genuinely ready.
  const readyRef = useRef(false);

  useEffect(() => {
    if (!editing) return;
    readyRef.current = false;
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
      readyRef.current = true;
    });
    return () => cancelAnimationFrame(raf);
  }, [editing]);

  const commit = () => {
    if (!readyRef.current) return;
    setEditing(false);
    const trimmed = value.trim();
    if (trimmed && trimmed !== stream.name) {
      onRename(trimmed);
    } else {
      setValue(stream.name);
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
          setValue(stream.name);
          setEditing(false);
        }
      }}
      onClick={(e) => e.preventDefault()}
      className="min-w-0 flex-1 select-text border-b border-border outline-none focus:border-border-pop"
    />
  ) : (
    <span className="truncate flex-1">{stream.name}</span>
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
          setValue(stream.name);
          setEditing(true);
        }}
      />
      <ContextMenuContent>
        <ContextMenuItem
          onClick={() => {
            setValue(stream.name);
            setEditing(true);
          }}
        >
          Rename stream
        </ContextMenuItem>
        <ContextMenuItem disabled={disabled} onClick={onTogglePinned}>
          {stream.pinned ? "Unpin stream" : "Pin stream"}
        </ContextMenuItem>
        {onReopen && (
          <ContextMenuItem disabled={disabled} onClick={onReopen}>
            Reopen stream
          </ContextMenuItem>
        )}
        {onClose && (
          <ContextMenuItem disabled={disabled} onClick={onClose}>
            Close stream
          </ContextMenuItem>
        )}
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
        `Failed to update stream pin: ${error instanceof Error ? error.message : String(error)}`,
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
        `Failed to rename stream: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });

  const closeStreamMutation = useMutation({
    mutationFn: (streamId: string) => apiClient.closeStream(streamId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["status"] });
    },
    onError: (error) => {
      toast.error(
        `Failed to close stream: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });

  const createStreamMutation = useCreateStream();
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
  const newStreamShortcutHint = useShortcutBindingLabel(SHORTCUT_ACTIONS.streamCreate, {
    altLabel: mod,
  });

  return (
    <aside className="flex h-full min-h-0 select-none flex-col overflow-hidden border-r border-border bg-background">
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

      {(defaultPiSessionId || allStreams.length > 0) && (
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-border pb-3 pl-3 pr-2 pt-1">
          {(defaultPiSessionId || openStreams.length > 0) && (
            <>
              <div className="flex items-center justify-between mb-2 ml-2">
                <p className="pt-2 text-[10px] font-medium uppercase tracking-wider text-text-muted">
                  Active streams
                </p>
                <div
                  className="group px-2 pt-2 pb-1 pl-4"
                  onClick={() => {
                    if (!createStreamMutation.isPending) createStreamMutation.mutate();
                  }}
                >
                  <button
                    type="button"
                    disabled={createStreamMutation.isPending}
                    aria-label="New stream"
                    title={
                      newStreamShortcutHint ? `New stream (${newStreamShortcutHint})` : "New stream"
                    }
                    className="flex size-4 items-center justify-center rounded text-sm leading-none text-text-muted transition-colors group-hover:bg-background-hover group-hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    +
                  </button>
                </div>
              </div>
              <div className="space-y-1">
                {defaultPiSessionId && (
                  <Link
                    to="/streams/$piSessionId"
                    params={{ piSessionId: defaultPiSessionId }}
                    className={cn(
                      "flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors",
                      currentPiSessionId === defaultPiSessionId ||
                        (pathname === "/streams" && !currentPiSessionId)
                        ? "bg-background-selected font-medium text-text"
                        : "text-text-muted hover:bg-background-hover hover:text-text",
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
                {openStreams.map((ws) => {
                  const piSessionId = ws.piSessionId;
                  const recoveryKind = getStreamRecoveryKind(ws);
                  const onReopen = recoveryKind
                    ? () => reopenStreamMutation.mutate({ streamId: ws.id, recoveryKind })
                    : undefined;

                  return piSessionId ? (
                    <StreamContextMenu
                      key={ws.id}
                      stream={ws}
                      disabled={pinStreamMutation.isPending || reopenStreamMutation.isPending}
                      onTogglePinned={() =>
                        pinStreamMutation.mutate({ streamId: ws.id, pinned: !ws.pinned })
                      }
                      onRename={(name) => renameStreamMutation.mutate({ streamId: ws.id, name })}
                      onReopen={onReopen}
                      onClose={() => closeStreamMutation.mutate(ws.id)}
                      renderTrigger={(label) => (
                        <Link
                          to="/streams/$piSessionId"
                          params={{ piSessionId }}
                          className={cn(
                            "group flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors",
                            currentPiSessionId === piSessionId
                              ? "bg-background-selected font-medium text-text"
                              : "text-text-muted hover:bg-background-hover hover:text-text",
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
                              aria-label="Unpin stream"
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
                      stream={ws}
                      disabled={pinStreamMutation.isPending || reopenStreamMutation.isPending}
                      onTogglePinned={() =>
                        pinStreamMutation.mutate({ streamId: ws.id, pinned: !ws.pinned })
                      }
                      onRename={(name) => renameStreamMutation.mutate({ streamId: ws.id, name })}
                      onReopen={onReopen}
                      onClose={() => closeStreamMutation.mutate(ws.id)}
                      renderTrigger={(label) => (
                        <div className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text-muted">
                          <span className={cn("shrink-0 size-2 rounded-full", "bg-status-ended")} />
                          {label}
                          {ws.pinned && (
                            <button
                              type="button"
                              aria-label="Unpin stream"
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
            </>
          )}

          {closedStreams.length > 0 && (
            <div className={defaultPiSessionId || openStreams.length > 0 ? "mt-6" : ""}>
              <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-text-muted">
                Recently closed
              </p>
              <div className="space-y-1">
                {closedStreams.map((ws) => {
                  const piSessionId = ws.piSessionId;
                  const recoveryKind = getStreamRecoveryKind(ws);
                  const onReopen = recoveryKind
                    ? () => reopenStreamMutation.mutate({ streamId: ws.id, recoveryKind })
                    : undefined;

                  return piSessionId ? (
                    <StreamContextMenu
                      key={ws.id}
                      stream={ws}
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
                          className={cn(
                            "group flex items-center justify-between px-2 py-1.5 rounded-md text-sm transition-colors",
                            currentPiSessionId === piSessionId
                              ? "bg-background-selected font-medium text-text"
                              : "text-text-muted hover:bg-background-hover hover:text-text",
                          )}
                        >
                          {label}
                          {ws.pinned && (
                            <button
                              type="button"
                              aria-label="Unpin stream"
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
        </div>
      )}

      {!defaultPiSessionId && allStreams.length === 0 && <div className="flex-1" />}
    </aside>
  );
});
