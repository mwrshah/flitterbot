import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { PinIcon, PinOffIcon, PlusIcon } from "lucide-react";
import {
  type MouseEvent,
  memo,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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

type SidebarSwimlaneRow =
  | {
      key: "default";
      kind: "default";
      section: "open";
      name: "flitterbot";
      piSessionId: string;
    }
  | {
      key: string;
      kind: "stream";
      section: "open" | "closed";
      name: string;
      piSessionId?: string;
      stream: StreamSummary;
    };

type PickerCandidate = SidebarSwimlaneRow & { piSessionId: string };

type PickerCursor = {
  originPath?: string;
  selectedKey?: string;
  selectedElement: HTMLElement | null;
  scrollFrame?: number;
};

const pickerSelectedRowClass =
  "data-[search-selected=true]:bg-background-hover data-[search-selected=true]:text-text";

function getAdjacentIndex(current: number, direction: 1 | -1, length: number): number {
  return Math.max(0, Math.min(current + direction, length - 1));
}

function getPiSessionId(pathname: string): string | undefined {
  return pathname.startsWith("/streams/") ? pathname.split("/")[2] : undefined;
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
  const navigate = useNavigate();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const swimlaneListRef = useRef<HTMLDivElement>(null);
  const liveRegionRef = useRef<HTMLSpanElement>(null);
  const pickerCursorRef = useRef<PickerCursor>({ selectedElement: null });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const setPickerSelection = useCallback(
    (candidates: readonly PickerCandidate[] = [], index = -1, deferDomUpdate = false) => {
      const cursor = pickerCursorRef.current;
      if (cursor.scrollFrame !== undefined) cancelAnimationFrame(cursor.scrollFrame);
      cursor.selectedElement?.removeAttribute("data-search-selected");
      cursor.scrollFrame = undefined;
      cursor.selectedElement = null;

      const candidate = candidates[index];
      cursor.selectedKey = candidate?.key;
      if (liveRegionRef.current) liveRegionRef.current.textContent = "";
      if (!candidate || deferDomUpdate) return;

      const element = swimlaneListRef.current?.querySelector<HTMLElement>(
        `[data-search-key="${CSS.escape(candidate.key)}"]`,
      );
      if (!element) return;

      cursor.selectedElement = element;
      element.setAttribute("data-search-selected", "true");
      const frame = requestAnimationFrame(() => {
        element.scrollIntoView({ block: "nearest" });
        if (cursor.scrollFrame === frame) cursor.scrollFrame = undefined;
      });
      cursor.scrollFrame = frame;
      if (liveRegionRef.current) {
        liveRegionRef.current.textContent = `${candidate.name}, ${index + 1} of ${candidates.length}`;
      }
    },
    [],
  );
  const clearPickerCursor = useCallback(() => {
    setPickerSelection();
    pickerCursorRef.current.originPath = undefined;
  }, [setPickerSelection]);
  const resetSearch = useCallback(() => {
    setQuery("");
    clearPickerCursor();
    searchInputRef.current?.blur();
  }, [clearPickerCursor]);
  const handleSwimlaneLinkClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      resetSearch();
    },
    [resetSearch],
  );

  useEffect(() => resetSearch(), [pathname, resetSearch]);

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

  const openRows: SidebarSwimlaneRow[] = [];
  if (defaultPiSessionId) {
    openRows.push({
      key: "default",
      kind: "default",
      section: "open",
      name: "flitterbot",
      piSessionId: defaultPiSessionId,
    });
  }
  for (const stream of openStreams) {
    openRows.push({
      key: `stream-${stream.id}`,
      kind: "stream",
      section: "open",
      name: stream.name,
      piSessionId: stream.piSessionId,
      stream,
    });
  }
  const closedRows: SidebarSwimlaneRow[] = [];
  for (const stream of closedStreams) {
    if (!stream.piSessionId) continue;
    closedRows.push({
      key: `stream-${stream.id}`,
      kind: "stream",
      section: "closed",
      name: stream.name,
      piSessionId: stream.piSessionId,
      stream,
    });
  }

  const normalizedQuery = query.trim().toLowerCase();
  const matchesQuery = (row: SidebarSwimlaneRow) =>
    row.name.toLowerCase().includes(normalizedQuery);
  const visibleOpenRows = normalizedQuery ? openRows.filter(matchesQuery) : openRows;
  const visibleClosedRows = normalizedQuery ? closedRows.filter(matchesQuery) : closedRows;
  const hasNoSearchResults =
    !!normalizedQuery && visibleOpenRows.length === 0 && visibleClosedRows.length === 0;
  const allSearchCandidates = [...openRows, ...closedRows].filter(
    (row): row is PickerCandidate => !!row.piSessionId,
  );
  const searchCandidates = normalizedQuery
    ? allSearchCandidates.filter(matchesQuery)
    : allSearchCandidates;
  const currentPiSessionId = getPiSessionId(pathname);

  useLayoutEffect(() => {
    const input = searchInputRef.current;
    const cursor = pickerCursorRef.current;
    if (
      document.activeElement !== input ||
      cursor.selectedElement?.isConnected ||
      searchCandidates.length === 0
    ) {
      return;
    }
    const selectedIndex = cursor.selectedKey
      ? searchCandidates.findIndex((row) => row.key === cursor.selectedKey)
      : -1;
    cursor.originPath = router.state.location.pathname;
    setPickerSelection(searchCandidates, selectedIndex === -1 ? 0 : selectedIndex);
  }, [searchCandidates, setPickerSelection]);

  const openStreamPicker = useEffectEvent((direction?: 1 | -1) => {
    const input = searchInputRef.current;
    if (!input) return false;
    if (direction) {
      const cursor = pickerCursorRef.current;
      const currentPathname = router.state.location.pathname;
      const continuing =
        document.activeElement === input &&
        cursor.originPath === currentPathname &&
        cursor.selectedKey !== undefined;
      const currentIndex = continuing
        ? allSearchCandidates.findIndex((row) => row.key === cursor.selectedKey)
        : allSearchCandidates.findIndex(
            (row) => row.piSessionId === getPiSessionId(currentPathname),
          );
      const selectedIndex =
        currentIndex === -1
          ? direction === 1
            ? 0
            : allSearchCandidates.length - 1
          : getAdjacentIndex(currentIndex, direction, allSearchCandidates.length);
      setQuery("");
      setPickerSelection(allSearchCandidates, selectedIndex, !!normalizedQuery);
      cursor.originPath = currentPathname;
    }
    input.focus();
    return true;
  });

  useEffect(() => {
    const unregister = registerShortcutHandlers([
      { actionId: SHORTCUT_ACTIONS.swimlaneSearch, handler: () => openStreamPicker() },
      { actionId: SHORTCUT_ACTIONS.streamPickerNext, handler: () => openStreamPicker(1) },
      { actionId: SHORTCUT_ACTIONS.streamPickerPrevious, handler: () => openStreamPicker(-1) },
    ]);
    return () => {
      unregister();
      clearPickerCursor();
    };
  }, [clearPickerCursor]);

  let nextShortcut = 1;
  const defaultShortcut = defaultPiSessionId && nextShortcut <= 9 ? nextShortcut++ : null;
  const streamShortcuts = new Map<string, number>();
  for (const ws of openStreams) {
    if (ws.piSessionId && nextShortcut <= 9) {
      streamShortcuts.set(ws.id, nextShortcut++);
    }
  }
  const surfaceShortcutHint = useShortcutBindingLabel(SHORTCUT_ACTIONS.navSurface, {
    altLabel: mod,
  });
  const streamsShortcutHint = useShortcutBindingLabel(SHORTCUT_ACTIONS.navLastStream, {
    altLabel: mod,
  });
  const newSwimlaneShortcutHint = useShortcutBindingLabel(SHORTCUT_ACTIONS.swimlaneCreate, {
    altLabel: mod,
  });
  const swimlaneSearchShortcutHint = useShortcutBindingLabel(SHORTCUT_ACTIONS.swimlaneSearch, {
    altLabel: mod,
  });
  const swimlaneSearchPlaceholder = `Search (${swimlaneSearchShortcutHint.replaceAll("+", " + ")})`;

  const renderSwimlaneRow = (row: SidebarSwimlaneRow) => {
    if (row.kind === "default") {
      return (
        <StreamContextMenu
          key={row.key}
          name={row.name}
          disabled={pinStreamMutation.isPending || reopenStreamMutation.isPending}
          renderTrigger={() => (
            <Link
              to="/streams/$piSessionId"
              params={{ piSessionId: row.piSessionId }}
              preload={false}
              onClick={handleSwimlaneLinkClick}
              data-search-key={row.key}
              className={cn(
                "group flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors",
                pickerSelectedRowClass,
                currentPiSessionId === row.piSessionId ||
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
              <span className="truncate flex-1">{row.name}</span>
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
      );
    }

    const stream = row.stream;
    const recoveryKind = getStreamRecoveryKind(stream);
    const onReopen = recoveryKind
      ? () => reopenStreamMutation.mutate({ streamId: stream.id, recoveryKind })
      : undefined;
    const menuProps = {
      name: stream.name,
      pinned: stream.pinned,
      disabled: pinStreamMutation.isPending || reopenStreamMutation.isPending,
      onTogglePinned: () =>
        pinStreamMutation.mutate({ streamId: stream.id, pinned: !stream.pinned }),
      onRename: (name: string) => renameStreamMutation.mutate({ streamId: stream.id, name }),
      onReopen,
    };

    if (!row.piSessionId) {
      return (
        <StreamContextMenu
          key={row.key}
          {...menuProps}
          onClose={() => closeSwimlaneMutation.mutate(stream.id)}
          renderTrigger={(label) => (
            <div className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text-muted">
              <span className="shrink-0 size-2 rounded-full bg-status-ended" />
              {label}
              {stream.pinned && (
                <button
                  type="button"
                  aria-label="Unpin swimlane"
                  className="group/pin ml-auto mr-0.5 hidden size-3 shrink-0 items-center justify-center text-text-muted hover:text-text group-hover:flex"
                  onClick={() => pinStreamMutation.mutate({ streamId: stream.id, pinned: false })}
                >
                  <PinIcon className="size-3 group-hover/pin:hidden" />
                  <PinOffIcon className="hidden size-3 group-hover/pin:block" />
                </button>
              )}
            </div>
          )}
        />
      );
    }

    const piSessionId = row.piSessionId;
    if (row.section === "closed") {
      return (
        <StreamContextMenu
          key={row.key}
          {...menuProps}
          renderTrigger={(label) => (
            <Link
              to="/streams/$piSessionId"
              params={{ piSessionId }}
              preload={false}
              onClick={handleSwimlaneLinkClick}
              data-search-key={row.key}
              className={cn(
                "group flex items-center justify-between px-2 py-1.5 rounded-md text-sm transition-colors",
                pickerSelectedRowClass,
                currentPiSessionId === piSessionId
                  ? "bg-background-selected text-text"
                  : "text-text-muted hover:bg-background-hover hover:text-text data-popup-open:bg-background-hover data-popup-open:text-text",
              )}
            >
              {label}
              {stream.pinned && (
                <button
                  type="button"
                  aria-label="Unpin swimlane"
                  className="group/pin ml-2 mr-0.5 flex size-3 shrink-0 items-center justify-center text-text-muted hover:text-text"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    pinStreamMutation.mutate({ streamId: stream.id, pinned: false });
                  }}
                >
                  <PinIcon className="size-3 group-hover/pin:hidden" />
                  <PinOffIcon className="hidden size-3 group-hover/pin:block" />
                </button>
              )}
            </Link>
          )}
        />
      );
    }

    const shortcut = streamShortcuts.get(stream.id);
    return (
      <StreamContextMenu
        key={row.key}
        {...menuProps}
        onClose={() => closeSwimlaneMutation.mutate(stream.id)}
        renderTrigger={(label) => (
          <Link
            to="/streams/$piSessionId"
            params={{ piSessionId }}
            preload={false}
            onClick={handleSwimlaneLinkClick}
            data-search-key={row.key}
            className={cn(
              "group flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors",
              pickerSelectedRowClass,
              currentPiSessionId === piSessionId
                ? "bg-background-selected text-text"
                : "text-text-muted hover:bg-background-hover hover:text-text data-popup-open:bg-background-hover data-popup-open:text-text",
            )}
          >
            <span
              className={cn(
                "shrink-0 size-2 rounded-full",
                piStatusDotClass(stream.piSessionStatus),
              )}
            />
            {label}
            {shortcut && (
              <ShortcutHint
                label={String(shortcut)}
                className={cn("ml-2 shrink-0", stream.pinned && "group-hover:hidden")}
                kbdSize="compact"
              />
            )}
            {stream.pinned && (
              <button
                type="button"
                aria-label="Unpin swimlane"
                className={cn(
                  "group/pin ml-2 mr-0.5 hidden size-3 shrink-0 items-center justify-center text-text-muted hover:text-text group-hover:flex",
                  !shortcut && "ml-auto",
                )}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  pinStreamMutation.mutate({ streamId: stream.id, pinned: false });
                }}
              >
                <PinIcon className="size-3 group-hover/pin:hidden" />
                <PinOffIcon className="hidden size-3 group-hover/pin:block" />
              </button>
            )}
          </Link>
        )}
      />
    );
  };

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
        <div
          ref={swimlaneListRef}
          className="min-h-0 flex-1 overflow-y-auto border-t border-border pb-3 pl-3 pr-2 pt-2"
        >
          <div className="flex items-center justify-between mb-0.5">
            <div className="-ml-1 flex h-6 min-w-0 flex-1 items-center">
              <input
                ref={searchInputRef}
                type="text"
                value={query}
                onChange={(event) => {
                  clearPickerCursor();
                  setQuery(event.target.value);
                }}
                onFocus={() => {
                  pickerCursorRef.current.originPath = router.state.location.pathname;
                  if (!pickerCursorRef.current.selectedKey) {
                    setPickerSelection(searchCandidates, 0);
                  }
                }}
                onBlur={clearPickerCursor}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    resetSearch();
                    return;
                  }
                  if (
                    (event.key === "ArrowDown" || event.key === "ArrowUp") &&
                    !event.altKey &&
                    !event.ctrlKey &&
                    !event.metaKey &&
                    !event.shiftKey
                  ) {
                    if (searchCandidates.length === 0) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const direction = event.key === "ArrowDown" ? 1 : -1;
                    const selectedIndex = searchCandidates.findIndex(
                      (row) => row.key === pickerCursorRef.current.selectedKey,
                    );
                    const currentIndex = selectedIndex === -1 ? 0 : selectedIndex;
                    const nextIndex = getAdjacentIndex(
                      currentIndex,
                      direction,
                      searchCandidates.length,
                    );
                    setPickerSelection(searchCandidates, nextIndex);
                    return;
                  }
                  if (event.key === "Enter") {
                    const selectedSearchCandidate =
                      searchCandidates.find(
                        (row) => row.key === pickerCursorRef.current.selectedKey,
                      ) ?? searchCandidates[0];
                    if (!selectedSearchCandidate) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const piSessionId = selectedSearchCandidate.piSessionId;
                    resetSearch();
                    void navigate({
                      to: "/streams/$piSessionId",
                      params: { piSessionId },
                    });
                  }
                }}
                placeholder={swimlaneSearchPlaceholder}
                aria-label="Search swimlanes by name"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                className="h-full min-w-0 flex-1 border-0 bg-transparent px-1 py-0 text-[10px] font-medium leading-4 text-text outline-none placeholder:font-medium placeholder:uppercase placeholder:tracking-wider placeholder:text-text-muted focus:shadow-[inset_0_-1px_0_var(--border-pop)] focus:placeholder:opacity-0"
              />
            </div>
            <span ref={liveRegionRef} className="sr-only" aria-live="polite" aria-atomic="true">
              {hasNoSearchResults ? `No swimlanes match “${query.trim()}”.` : ""}
            </span>
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

          {visibleOpenRows.length > 0 && <div>{visibleOpenRows.map(renderSwimlaneRow)}</div>}

          {visibleClosedRows.length > 0 && (
            <div className={visibleOpenRows.length > 0 ? "mt-6" : ""}>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-muted">
                Recently closed
              </p>
              <div>{visibleClosedRows.map(renderSwimlaneRow)}</div>
            </div>
          )}

          {hasNoSearchResults && (
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
