import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { PinIcon, PinOffIcon, PlusIcon } from "lucide-react";
import {
  type MouseEvent,
  memo,
  type ReactElement,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import logoBlack from "@/assets/flitterbot_logo_black_small.png";
import logoWhite from "@/assets/flitterbot_logo_white_small.png";
import { ShortcutHint } from "@/components/common/kbd";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useModifierLabel } from "@/hooks/platform";
import { useCreateSwimlane } from "@/hooks/use-create-swimlane";
import { useLastStreamPath } from "@/hooks/use-last-stream-path";
import { useReopenStream } from "@/hooks/use-reopen-stream";
import { useWhyDidYouRender } from "@/hooks/use-why-did-you-render";
import {
  registerShortcutHandlers,
  SHORTCUT_ACTIONS,
  useShortcutBindingLabel,
} from "@/lib/global-shortcuts";
import { sessionSearchQueryOptions, statusQueryOptions } from "@/lib/queries";
import { projectSidebarRows } from "@/lib/sidebar-search";
import { getStreamRecoveryKind, type StreamRecoveryKind } from "@/lib/stream-recovery";
import type { PiSessionStatus, StreamSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

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
      <ContextMenuContent data-sidebar-interaction>
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
  selectedKey?: string | null;
  selectedElement: HTMLElement | null;
  scrollFrame?: number;
};

const pickerSelectedRowClass =
  "data-[search-selected=true]:bg-background-hover data-[search-selected=true]:text-text";
const EMPTY_SESSION_MATCH_COUNTS = new Map<string, number>();

function getAdjacentPickerIndex(current: number, direction: 1 | -1, length: number): number {
  const next = current + direction;
  if (next < -1) return length - 1;
  if (next >= length) return -1;
  return next;
}

function getPiSessionId(pathname: string): string | undefined {
  return pathname.startsWith("/streams/") ? pathname.split("/")[2] : undefined;
}

type PinStream = (variables: { streamId: string; pinned: boolean }) => void;
type RenameStream = (variables: { streamId: string; name: string }) => void;
type ReopenStream = (variables: { streamId: string; recoveryKind: StreamRecoveryKind }) => void;
type CloseStream = (streamId: string) => void;

const SwimlaneRow = memo(function SwimlaneRow({
  row,
  active,
  defaultBusy,
  shortcut,
  actionsDisabled,
  onLinkClick,
  pinStream,
  renameStream,
  reopenStream,
  closeStream,
}: {
  row: SidebarSwimlaneRow;
  active: boolean;
  defaultBusy: boolean;
  shortcut?: number | null;
  actionsDisabled: boolean;
  onLinkClick: (event: MouseEvent<HTMLAnchorElement>) => void;
  pinStream: PinStream;
  renameStream: RenameStream;
  reopenStream: ReopenStream;
  closeStream: CloseStream;
}) {
  if (row.kind === "default") {
    return (
      <StreamContextMenu
        name={row.name}
        disabled={actionsDisabled}
        renderTrigger={() => (
          <Link
            to="/streams/$piSessionId"
            params={{ piSessionId: row.piSessionId }}
            preload={false}
            onClick={onLinkClick}
            data-search-key={row.key}
            className={cn(
              "group flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors",
              pickerSelectedRowClass,
              active
                ? "bg-background-selected text-text"
                : "text-text-muted hover:bg-background-hover hover:text-text data-popup-open:bg-background-hover data-popup-open:text-text",
            )}
          >
            <span
              className={cn(
                "shrink-0 size-2 rounded-full",
                defaultBusy ? "bg-status-active" : "bg-status-ended",
              )}
            />
            <span className="truncate flex-1">{row.name}</span>
            {shortcut && (
              <ShortcutHint label={String(shortcut)} className="ml-2 shrink-0" kbdSize="compact" />
            )}
          </Link>
        )}
      />
    );
  }

  const stream = row.stream;
  const recoveryKind = getStreamRecoveryKind(stream);
  const onReopen = recoveryKind
    ? () => reopenStream({ streamId: stream.id, recoveryKind })
    : undefined;
  const menuProps = {
    name: stream.name,
    pinned: stream.pinned,
    disabled: actionsDisabled,
    onTogglePinned: () => pinStream({ streamId: stream.id, pinned: !stream.pinned }),
    onRename: (name: string) => renameStream({ streamId: stream.id, name }),
    onReopen,
  };

  if (!row.piSessionId) {
    return (
      <StreamContextMenu
        {...menuProps}
        onClose={() => closeStream(stream.id)}
        renderTrigger={(label) => (
          <div className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text-muted">
            <span className="shrink-0 size-2 rounded-full bg-status-ended" />
            {label}
            {stream.pinned && (
              <button
                type="button"
                aria-label="Unpin swimlane"
                className="group/pin ml-auto mr-0.5 hidden size-3 shrink-0 items-center justify-center text-text-muted hover:text-text group-hover:flex"
                onClick={() => pinStream({ streamId: stream.id, pinned: false })}
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
        {...menuProps}
        renderTrigger={(label) => (
          <Link
            to="/streams/$piSessionId"
            params={{ piSessionId }}
            preload={false}
            onClick={onLinkClick}
            data-search-key={row.key}
            className={cn(
              "group flex items-center justify-between px-2 py-1.5 rounded-md text-sm transition-colors",
              pickerSelectedRowClass,
              active
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
                  pinStream({ streamId: stream.id, pinned: false });
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

  return (
    <StreamContextMenu
      {...menuProps}
      onClose={() => closeStream(stream.id)}
      renderTrigger={(label) => (
        <Link
          to="/streams/$piSessionId"
          params={{ piSessionId }}
          preload={false}
          onClick={onLinkClick}
          data-search-key={row.key}
          className={cn(
            "group flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors",
            pickerSelectedRowClass,
            active
              ? "bg-background-selected text-text"
              : "text-text-muted hover:bg-background-hover hover:text-text data-popup-open:bg-background-hover data-popup-open:text-text",
          )}
        >
          <span
            className={cn("shrink-0 size-2 rounded-full", piStatusDotClass(stream.piSessionStatus))}
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
                pinStream({ streamId: stream.id, pinned: false });
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
});

const SwimlaneRows = memo(function SwimlaneRows({
  openRows,
  closedRows,
  emptyQuery,
  currentPiSessionId,
  defaultRouteActive,
  defaultBusy,
  defaultShortcut,
  streamShortcuts,
  actionsDisabled,
  onLinkClick,
  pinStream,
  renameStream,
  reopenStream,
  closeStream,
}: {
  openRows: readonly SidebarSwimlaneRow[];
  closedRows: readonly SidebarSwimlaneRow[];
  emptyQuery?: string;
  currentPiSessionId?: string;
  defaultRouteActive: boolean;
  defaultBusy: boolean;
  defaultShortcut: number | null;
  streamShortcuts: ReadonlyMap<string, number>;
  actionsDisabled: boolean;
  onLinkClick: (event: MouseEvent<HTMLAnchorElement>) => void;
  pinStream: PinStream;
  renameStream: RenameStream;
  reopenStream: ReopenStream;
  closeStream: CloseStream;
}) {
  const renderRow = (row: SidebarSwimlaneRow) => (
    <SwimlaneRow
      key={row.key}
      row={row}
      active={
        currentPiSessionId === row.piSessionId || (row.kind === "default" && defaultRouteActive)
      }
      defaultBusy={row.kind === "default" && defaultBusy}
      shortcut={row.kind === "default" ? defaultShortcut : streamShortcuts.get(row.stream.id)}
      actionsDisabled={actionsDisabled}
      onLinkClick={onLinkClick}
      pinStream={pinStream}
      renameStream={renameStream}
      reopenStream={reopenStream}
      closeStream={closeStream}
    />
  );

  return (
    <>
      {openRows.length > 0 && <div>{openRows.map(renderRow)}</div>}

      {closedRows.length > 0 && (
        <div className={openRows.length > 0 ? "mt-6" : ""}>
          <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-muted">
            Recently closed
          </p>
          <div>{closedRows.map(renderRow)}</div>
        </div>
      )}

      {emptyQuery && (
        <p className="ml-2 mt-2 text-[11px] text-text-muted">No swimlanes match “{emptyQuery}”.</p>
      )}
    </>
  );
});

const icons = {
  surface: (
    <svg viewBox="0 0 16 16" fill="currentColor" className="size-4">
      <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h11A1.5 1.5 0 0 1 15 3.5v1A1.5 1.5 0 0 1 13.5 6h-11A1.5 1.5 0 0 1 1 4.5v-1ZM1 8.5A1.5 1.5 0 0 1 2.5 7h11A1.5 1.5 0 0 1 15 8.5v1A1.5 1.5 0 0 1 13.5 11h-11A1.5 1.5 0 0 1 1 9.5v-1ZM2.5 12A1.5 1.5 0 0 0 1 13.5v.5h14v-.5a1.5 1.5 0 0 0-1.5-1.5h-11Z" />
    </svg>
  ),
};

function SidebarSwimlanes({ modifierLabel }: { modifierLabel: string }) {
  const rootApi = getRouteApi("__root__");
  const { apiClient } = rootApi.useRouteContext();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearchQuery(normalizedQuery), 150);
    return () => clearTimeout(id);
  }, [normalizedQuery]);
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
      cursor.selectedKey = index === -1 ? null : candidate?.key;
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
  const selectPickerIndex = useCallback(
    (candidates: readonly PickerCandidate[], index: number, deferDomUpdate = false) => {
      const input = searchInputRef.current;
      input?.removeAttribute("data-search-selected");
      setPickerSelection(candidates, index, deferDomUpdate);
      if (index === -1) {
        const cursor = pickerCursorRef.current;
        input?.setAttribute("data-search-selected", "true");
        if (input) {
          const frame = requestAnimationFrame(() => {
            swimlaneListRef.current?.scrollTo({ top: 0 });
            if (cursor.scrollFrame === frame) cursor.scrollFrame = undefined;
          });
          cursor.scrollFrame = frame;
        }
        if (liveRegionRef.current) liveRegionRef.current.textContent = "Search swimlanes";
      }
    },
    [setPickerSelection],
  );
  const clearPickerCursor = useCallback(() => {
    setPickerSelection();
    searchInputRef.current?.removeAttribute("data-search-selected");
    pickerCursorRef.current.originPath = undefined;
  }, [setPickerSelection]);
  const resetSearch = useCallback(() => {
    setQuery("");
    clearPickerCursor();
    searchInputRef.current?.blur();
  }, [clearPickerCursor]);
  const resetSearchOnOutsidePointer = useEffectEvent((ownerDocument: Document) => {
    const input = searchInputRef.current;
    if (query || ownerDocument.activeElement === input) resetSearch();
  });

  useEffect(() => {
    if (typeof document === "undefined") return;

    const ownerDocument = document;
    const ElementConstructor = ownerDocument.defaultView?.Element;
    if (!ElementConstructor) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof ElementConstructor && target.closest("[data-sidebar-interaction]")) {
        return;
      }
      resetSearchOnOutsidePointer(ownerDocument);
    };

    ownerDocument.addEventListener("pointerdown", handlePointerDown, true);
    return () => ownerDocument.removeEventListener("pointerdown", handlePointerDown, true);
  }, []);

  const handleSwimlaneLinkClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      clearPickerCursor();
    },
    [clearPickerCursor],
  );

  const statusQuery = useQuery({
    ...statusQueryOptions(apiClient),
    retry: 1,
  });
  const sessionSearchQuery = useQuery(
    sessionSearchQueryOptions(apiClient, debouncedSearchQuery, !!debouncedSearchQuery),
  );
  const sessionMatchCounts = useMemo(
    () =>
      new Map(
        sessionSearchQuery.data?.matches.map(({ piSessionId, matchCount }) => [
          piSessionId,
          matchCount,
        ]) ?? [],
      ),
    [sessionSearchQuery.data],
  );

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
  const allStreams = status?.streams;
  const { allRows, allSearchCandidates, defaultShortcut, streamShortcuts } = useMemo(() => {
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

    const closedRows: SidebarSwimlaneRow[] = [];
    for (const stream of allStreams ?? []) {
      if (stream.status === "open") {
        openRows.push({
          key: `stream-${stream.id}`,
          kind: "stream",
          section: "open",
          name: stream.name,
          piSessionId: stream.piSessionId,
          stream,
        });
      } else if (stream.status === "closed" && stream.piSessionId) {
        closedRows.push({
          key: `stream-${stream.id}`,
          kind: "stream",
          section: "closed",
          name: stream.name,
          piSessionId: stream.piSessionId,
          stream,
        });
      }
    }

    const allRows = [...openRows, ...closedRows];
    const allSearchCandidates = allRows.filter((row): row is PickerCandidate => !!row.piSessionId);
    let nextShortcut = 1;
    const defaultShortcut = defaultPiSessionId && nextShortcut <= 9 ? nextShortcut++ : null;
    const streamShortcuts = new Map<string, number>();
    for (const row of openRows) {
      if (row.kind === "stream" && row.piSessionId && nextShortcut <= 9) {
        streamShortcuts.set(row.stream.id, nextShortcut++);
      }
    }

    return { allRows, allSearchCandidates, defaultShortcut, streamShortcuts };
  }, [allStreams, defaultPiSessionId]);

  const deferredQuery = useDeferredValue(query);
  const normalizedDeferredQuery = deferredQuery.trim().toLowerCase();
  const currentSessionMatchCounts =
    sessionSearchQuery.data && !sessionSearchQuery.isError
      ? sessionMatchCounts
      : EMPTY_SESSION_MATCH_COUNTS;
  const { visibleOpenRows, visibleClosedRows } = useMemo(() => {
    const visibleRows = projectSidebarRows(
      allRows,
      normalizedDeferredQuery,
      currentSessionMatchCounts,
    );
    return {
      visibleOpenRows: visibleRows.filter((row) => row.section === "open"),
      visibleClosedRows: visibleRows.filter((row) => row.section === "closed"),
    };
  }, [allRows, currentSessionMatchCounts, normalizedDeferredQuery]);
  const contentSearchFinished =
    sessionSearchQuery.isError ||
    (debouncedSearchQuery === normalizedDeferredQuery &&
      !!sessionSearchQuery.data &&
      !sessionSearchQuery.isPlaceholderData);
  const hasNoSearchResults =
    !!normalizedDeferredQuery &&
    contentSearchFinished &&
    visibleOpenRows.length === 0 &&
    visibleClosedRows.length === 0;
  const currentSearchCandidates = useMemo(
    () =>
      projectSidebarRows(allRows, normalizedQuery, currentSessionMatchCounts).filter(
        (row): row is PickerCandidate => !!row.piSessionId,
      ),
    [allRows, currentSessionMatchCounts, normalizedQuery],
  );
  const displayedSearchCandidates = useMemo(
    () =>
      [...visibleOpenRows, ...visibleClosedRows].filter(
        (row): row is PickerCandidate => !!row.piSessionId,
      ),
    [visibleClosedRows, visibleOpenRows],
  );
  const currentPiSessionId = getPiSessionId(pathname);

  useLayoutEffect(() => {
    const input = searchInputRef.current;
    const cursor = pickerCursorRef.current;
    if (
      document.activeElement !== input ||
      cursor.selectedElement?.isConnected ||
      cursor.selectedKey === null ||
      displayedSearchCandidates.length === 0
    ) {
      return;
    }
    const selectedIndex = cursor.selectedKey
      ? displayedSearchCandidates.findIndex((row) => row.key === cursor.selectedKey)
      : -1;
    cursor.originPath = router.state.location.pathname;
    setPickerSelection(displayedSearchCandidates, selectedIndex === -1 ? 0 : selectedIndex);
  }, [displayedSearchCandidates, setPickerSelection]);

  const openStreamPicker = useEffectEvent((direction?: 1 | -1) => {
    const input = searchInputRef.current;
    if (!input) return false;
    if (direction) {
      const cursor = pickerCursorRef.current;
      const currentPathname = router.state.location.pathname;
      const inputFocused = document.activeElement === input;
      const candidates = inputFocused ? currentSearchCandidates : allSearchCandidates;
      const continuing = inputFocused && cursor.originPath === currentPathname;
      const currentIndex = continuing
        ? candidates.findIndex((row) => row.key === cursor.selectedKey)
        : candidates.findIndex((row) => row.piSessionId === getPiSessionId(currentPathname));
      const selectedIndex =
        !continuing && currentIndex === -1
          ? direction === 1
            ? 0
            : candidates.length - 1
          : getAdjacentPickerIndex(currentIndex, direction, candidates.length);
      if (!inputFocused) setQuery("");
      selectPickerIndex(candidates, selectedIndex, !inputFocused && !!normalizedDeferredQuery);
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

  const newSwimlaneShortcutHint = useShortcutBindingLabel(SHORTCUT_ACTIONS.swimlaneCreate, {
    altLabel: modifierLabel,
  });
  const swimlaneSearchShortcutHint = useShortcutBindingLabel(SHORTCUT_ACTIONS.swimlaneSearch, {
    altLabel: modifierLabel,
  });
  const swimlaneSearchPlaceholder = `Search (${swimlaneSearchShortcutHint.replaceAll("+", " + ")})`;

  if (!defaultPiSessionId && !allStreams?.length) return <div className="flex-1" />;

  return (
    <div
      ref={swimlaneListRef}
      className="min-h-0 w-[calc(100%+1px)] flex-1 overflow-x-hidden overflow-y-auto border-t border-border pb-3 pl-3 pr-2 pt-2"
    >
      <div className="flex items-center justify-between mb-0.5">
        <div className="-ml-1 flex h-6 min-w-0 flex-1 items-center">
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(event) => {
              const nextQuery = event.target.value;
              const normalizedNextQuery = nextQuery.trim().toLowerCase();
              const nextSessionMatchCounts =
                sessionSearchQuery.data && !sessionSearchQuery.isError
                  ? sessionMatchCounts
                  : EMPTY_SESSION_MATCH_COUNTS;
              const nextCandidates = projectSidebarRows(
                allRows,
                normalizedNextQuery,
                nextSessionMatchCounts,
              ).filter((row): row is PickerCandidate => !!row.piSessionId);
              clearPickerCursor();
              setQuery(nextQuery);
              pickerCursorRef.current.originPath = router.state.location.pathname;
              setPickerSelection(nextCandidates, 0);
            }}
            onFocus={() => {
              const cursor = pickerCursorRef.current;
              const hasPickerPosition = cursor.originPath !== undefined;
              cursor.originPath = router.state.location.pathname;
              if (!cursor.selectedKey && !hasPickerPosition) {
                setPickerSelection(currentSearchCandidates, 0);
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
                if (currentSearchCandidates.length === 0) return;
                event.preventDefault();
                event.stopPropagation();
                const direction = event.key === "ArrowDown" ? 1 : -1;
                const selectedIndex = currentSearchCandidates.findIndex(
                  (row) => row.key === pickerCursorRef.current.selectedKey,
                );
                const nextIndex = getAdjacentPickerIndex(
                  selectedIndex,
                  direction,
                  currentSearchCandidates.length,
                );
                selectPickerIndex(currentSearchCandidates, nextIndex);
                return;
              }
              if (event.key === "Enter") {
                const selectedKey = pickerCursorRef.current.selectedKey;
                if (!selectedKey) return;
                const selectedSearchCandidate = currentSearchCandidates.find(
                  (row) => row.key === selectedKey,
                );
                if (!selectedSearchCandidate) return;
                event.preventDefault();
                event.stopPropagation();
                const piSessionId = selectedSearchCandidate.piSessionId;
                clearPickerCursor();
                void navigate({
                  to: "/streams/$piSessionId",
                  params: { piSessionId },
                });
              }
            }}
            placeholder={swimlaneSearchPlaceholder}
            aria-label="Search swimlanes"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="h-full min-w-0 flex-1 border-0 border-b-2 border-transparent bg-transparent px-1 py-0 text-[10px] font-medium leading-4 text-text outline-none placeholder:font-medium placeholder:uppercase placeholder:tracking-wider placeholder:text-text-muted focus:border-border-pop focus:placeholder:opacity-0 data-[search-selected=true]:rounded-sm data-[search-selected=true]:focus:border-transparent data-[search-selected=true]:ring-1 data-[search-selected=true]:ring-inset data-[search-selected=true]:ring-border-pop"
          />
        </div>
        <span ref={liveRegionRef} className="sr-only" aria-live="polite" aria-atomic="true">
          {hasNoSearchResults ? `No swimlanes match “${deferredQuery.trim()}”.` : ""}
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
              newSwimlaneShortcutHint ? `New swimlane (${newSwimlaneShortcutHint})` : "New swimlane"
            }
            className="flex size-6 items-center justify-center rounded text-sm leading-none text-text-muted transition-colors group-hover:bg-background-hover group-hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            <PlusIcon className="size-3" aria-hidden />
          </button>
        </div>
      </div>

      <SwimlaneRows
        openRows={visibleOpenRows}
        closedRows={visibleClosedRows}
        emptyQuery={hasNoSearchResults ? deferredQuery.trim() : undefined}
        currentPiSessionId={currentPiSessionId}
        defaultRouteActive={pathname === "/streams" && !currentPiSessionId}
        defaultBusy={status?.piAgent?.default?.busy ?? false}
        defaultShortcut={defaultShortcut}
        streamShortcuts={streamShortcuts}
        actionsDisabled={pinStreamMutation.isPending || reopenStreamMutation.isPending}
        onLinkClick={handleSwimlaneLinkClick}
        pinStream={pinStreamMutation.mutate}
        renameStream={renameStreamMutation.mutate}
        reopenStream={reopenStreamMutation.mutate}
        closeStream={closeSwimlaneMutation.mutate}
      />
    </div>
  );
}

export const Sidebar = memo(function Sidebar() {
  const modifierLabel = useModifierLabel();
  const lastStreamPath = useLastStreamPath();
  useWhyDidYouRender("Sidebar", {});
  const surfaceShortcutHint = useShortcutBindingLabel(SHORTCUT_ACTIONS.navSurface, {
    altLabel: modifierLabel,
  });
  const streamsShortcutHint = useShortcutBindingLabel(SHORTCUT_ACTIONS.navLastStream, {
    altLabel: modifierLabel,
  });

  return (
    <aside
      data-sidebar-interaction
      className="flex h-full min-h-0 select-none flex-col overflow-hidden bg-background"
    >
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
      <SidebarSwimlanes modifierLabel={modifierLabel} />
    </aside>
  );
});
