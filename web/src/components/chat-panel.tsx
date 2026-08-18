import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  FolderPenIcon,
  Loader2Icon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  memo,
  type RefObject,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Layout as PanelLayout } from "react-resizable-panels";
import { toast } from "sonner";
import { Button } from "@/components/common/button";
import { ShortcutHint } from "@/components/common/kbd";
import { MessageInput, type MessageInputHoverButton } from "@/components/common/message-input";
import { HorizontalResizeHandle, Panel, PanelGroup } from "@/components/common/resizable";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useReopenStream } from "@/hooks/use-reopen-stream";
import { parsePanelLayout, useUserConfig } from "@/hooks/use-user-config";
import { useWhyDidYouRender } from "@/hooks/use-why-did-you-render";
import {
  buildConversationFindIndex,
  conversationFindRowAt,
  EMPTY_CONVERSATION_FIND_RESULTS,
  findConversationMatches,
  mergeFindTimeline,
  moveConversationFindSelection,
} from "@/lib/conversation-find";
import { applyTurnQueueSnapshot, invalidateHistorySnapshot } from "@/lib/conversation-history";
import { buildConversationRows } from "@/lib/conversation-rows";
import {
  focusComposerInput,
  isShortcutInput,
  registerShortcutHandlers,
  SHORTCUT_ACTIONS,
  useShortcutBindingLabel,
} from "@/lib/global-shortcuts";
import {
  conversationFindHistoryQueryOptions,
  directoryCompletionsQueryOptions,
  streamsWorktreeQueryOptions,
} from "@/lib/queries";
import type { StreamRecoveryKind } from "@/lib/stream-recovery";
import { getTokenDeleteEdit } from "@/lib/text-input";
import type {
  ChatTimelineItem,
  ChatTimelineMessage,
  DirectoryCompletionItem,
  ImageAttachment,
  StreamSummary,
  TokenUsage,
  TurnQueueSnapshot,
} from "@/lib/types";
import { setStreamCwd } from "@/server/streams";
import { StreamsMessageList, type StreamsMessageListHandle } from "./streams-message-list";

const CHAT_LAYOUT_KEY = "panel:chat-layout";
const CHAT_LAYOUT_DEFAULT: Record<string, number> = { feed: 85, input: 15 };

const rootApi = getRouteApi("__root__");
const BLOCKING_SURFACE_SELECTOR = [
  '[data-slot="dialog-content"][data-open]',
  '[data-slot="dropdown-menu-content"][data-open]',
  '[data-slot="context-menu-content"][data-open]',
  "[data-inline-command-picker]",
].join(",");

function hasBlockingSurface(): boolean {
  return Boolean(document.querySelector(BLOCKING_SURFACE_SELECTOR));
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}

const ContextTicker = memo(function ContextTicker({ usage }: { usage: TokenUsage | null }) {
  const cacheRead = usage ? formatTokens(usage.cacheRead) : "—";
  const contextTokens = usage ? formatTokens(usage.totalTokens) : "—";

  return (
    <span
      className="ml-auto shrink-0 text-xs text-text-muted tabular-nums"
      title="Latest request. Pi reports cache reuse, but not cache misses, age, or expiry time."
    >
      cache: {cacheRead}/{contextTokens}
    </span>
  );
});

type ChatPanelProps = {
  piSessionId: string;
  timeline: ChatTimelineItem[];
  turnQueue: TurnQueueSnapshot;
  isSessionBusy: boolean;
  isSessionCompacting: boolean;
  contextUsage: TokenUsage | null;
  onSendMessage: (
    text: string,
    options?: { images?: ImageAttachment[]; clientMessageId?: string },
  ) => Promise<void>;
  onLoadPrevious: () => void;
  hasPreviousPage: boolean;
  isFetchingPreviousPage: boolean;
  streamId?: string;
  streamName?: string;
  streamType?: StreamSummary["type"];
  streamHasWorktree?: boolean;
  selectedModelId?: string;
  selectedThinkingLevel?: ModelThinkingLevel;
  recoveryKind?: StreamRecoveryKind;
  messageInputDisabled: boolean;
};

type ConversationFindBarProps = {
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  matchIndex: number;
  matchCount: number;
  loading: boolean;
  error: Error | null;
  onValueChange: (value: string) => void;
  onMove: (delta: -1 | 1) => void;
  onRetry: () => void;
  onClose: () => void;
};

function ConversationFindBar({
  inputRef,
  value,
  matchIndex,
  matchCount,
  loading,
  error,
  onValueChange,
  onMove,
  onRetry,
  onClose,
}: ConversationFindBarProps) {
  const status = loading
    ? "Loading…"
    : value
      ? `${matchCount ? matchIndex + 1 : 0}/${matchCount}`
      : "";
  const canMove = !loading && !error && matchCount > 0;
  const [showFocusHint, setShowFocusHint] = useState(false);
  const navigationButtonClass =
    "flex size-9 shrink-0 touch-manipulation items-center justify-center rounded text-text-muted hover:bg-background-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-pop disabled:opacity-35 sm:size-7";

  useEffect(() => {
    const updateFocusHint = (target: EventTarget | null) => {
      setShowFocusHint(!isShortcutInput(target));
    };
    const handleFocusIn = (event: globalThis.FocusEvent) => updateFocusHint(event.target);
    const handleFocusOut = (event: globalThis.FocusEvent) => updateFocusHint(event.relatedTarget);

    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("focusout", handleFocusOut);
    return () => {
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("focusout", handleFocusOut);
    };
  }, []);

  return (
    <form
      role="search"
      aria-label="Find in conversation"
      onSubmit={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      className="absolute top-2 right-2 z-20 flex h-11 w-[min(28rem,calc(100%-1rem))] items-center gap-1 rounded-lg border border-border bg-background px-2 shadow-md focus-within:ring-2 focus-within:ring-border-pop sm:h-9"
    >
      <SearchIcon className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 items-center">
        <input
          ref={inputRef}
          name="conversation-find"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder="Find…"
          aria-label="Find in conversation"
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter" || event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              event.stopPropagation();
              onMove(event.key === "ArrowUp" || (event.key === "Enter" && event.shiftKey) ? -1 : 1);
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-base text-text outline-none placeholder:text-text-muted sm:text-sm"
        />
        {showFocusHint && (
          <span className="shrink-0 pl-2 text-xs text-text-muted" aria-hidden="true">
            Press f to jump here
          </span>
        )}
      </div>
      {error && !loading ? (
        <>
          <span id="conversation-find-error" role="alert" className="sr-only">
            Conversation history failed to load: {error.message}
          </span>
          <button
            type="button"
            onClick={onRetry}
            aria-describedby="conversation-find-error"
            className="shrink-0 rounded px-1 text-xs text-status-crashed hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-pop"
          >
            Retry
          </button>
        </>
      ) : (
        <span className="shrink-0 text-xs text-text-muted tabular-nums" aria-live="polite">
          {loading && (
            <Loader2Icon className="mr-1 inline size-3 animate-spin" aria-hidden="true" />
          )}
          {status}
        </span>
      )}
      <button
        type="button"
        disabled={!canMove}
        onClick={() => onMove(-1)}
        className={navigationButtonClass}
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
      >
        <ChevronUpIcon className="size-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        disabled={!canMove}
        onClick={() => onMove(1)}
        className={navigationButtonClass}
        aria-label="Next match"
        title="Next match (Enter)"
      >
        <ChevronDownIcon className="size-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onClose}
        className="flex size-9 shrink-0 touch-manipulation items-center justify-center rounded text-text-muted hover:bg-background-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-pop sm:size-7"
        aria-label="Close find"
        title="Close find (Escape)"
      >
        <XIcon className="size-4" aria-hidden="true" />
      </button>
    </form>
  );
}

function dirFromPath(path: string, name: string): string {
  const cleanPath = path.endsWith("/") ? path.slice(0, -1) : path;
  if (cleanPath.endsWith(`/${name}`)) return cleanPath.slice(0, -(name.length + 1));
  if (cleanPath === name) return "";
  return cleanPath;
}

function CwdPicker({
  pickerRef,
  pickerStyle,
  open,
  value,
  items,
  pending,
  onValueChange,
  onDrill,
  onCommit,
  onEscape,
}: {
  pickerRef?: RefObject<HTMLDivElement | null>;
  pickerStyle?: CSSProperties;
  open: boolean;
  value: string;
  items: DirectoryCompletionItem[];
  pending: boolean;
  onValueChange: (value: string) => void;
  onDrill: (item: DirectoryCompletionItem) => void;
  onCommit: () => void;
  onEscape: () => void;
}) {
  const [selectedValue, setSelectedValue] = useState("");

  useLayoutEffect(() => {
    if (!open) return;
    setSelectedValue(items[0]?.path ?? "");
    const list = pickerRef?.current?.querySelector<HTMLElement>("[cmdk-list-sizer]")?.parentElement;
    if (list) list.scrollTop = 0;
  }, [open, items, pickerRef]);

  const handleValueChange = useCallback(
    (nextValue: string) => {
      onValueChange(`@${nextValue.replace(/^@+/, "")}`);
    },
    [onValueChange],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const input = event.target;
      if (input instanceof HTMLInputElement) {
        const selectionStart = input.selectionStart ?? value.length;
        const tokenDeleteEdit = getTokenDeleteEdit(
          event,
          value,
          selectionStart,
          input.selectionEnd ?? selectionStart,
        );
        if (tokenDeleteEdit) {
          event.preventDefault();
          event.stopPropagation();
          handleValueChange(tokenDeleteEdit.value);
          requestAnimationFrame(() => {
            const cursor = Math.max(1, tokenDeleteEdit.cursor);
            input.setSelectionRange(cursor, cursor);
          });
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onEscape();
        return;
      }
      if (event.key === "Enter" && (/\s$/.test(value) || (items.length === 0 && value !== "@"))) {
        event.preventDefault();
        event.stopPropagation();
        onCommit();
      }
    },
    [handleValueChange, items.length, onCommit, onEscape, value],
  );

  if (!open) return null;

  return (
    <div
      ref={pickerRef}
      style={pickerStyle}
      className="absolute top-full z-50 mt-1 rounded-lg border border-border bg-background p-1 shadow-lg"
    >
      <Command
        shouldFilter={false}
        loop
        value={selectedValue}
        onValueChange={setSelectedValue}
        onKeyDownCapture={handleKeyDown}
        className="rounded-md border-0 shadow-none"
      >
        <div className="relative w-full [&_[data-slot=command-input-wrapper]]:min-w-0 [&_[data-slot=input-group-addon]]:hidden">
          <CommandInput
            autoFocus
            value={value}
            onValueChange={handleValueChange}
            placeholder="@../project/"
            className="pr-10 font-mono text-xs"
          />
          <button
            type="button"
            onClick={onCommit}
            disabled={pending}
            className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-sm text-text-muted hover:bg-background-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
            title="switch cwd to this path"
          >
            →
          </button>
        </div>
        <CommandList className="max-h-80 overflow-y-auto p-1">
          {items.length === 0 && (
            <CommandEmpty className="px-3 py-2 text-sm text-text-muted">
              No matching paths
            </CommandEmpty>
          )}
          {items.map((item) => {
            const dir = dirFromPath(item.path, item.name);
            return (
              <CommandItem
                key={item.path}
                value={item.path}
                onSelect={() => onDrill(item)}
                className="!flex !flex-col !items-start gap-0 rounded-md px-3 py-1.5 text-sm cursor-pointer data-[selected=true]:bg-background-selected [&>svg]:!hidden"
              >
                <span className="flex items-baseline gap-2 min-w-0">
                  <span className="shrink-0">📁</span>
                  <span className="font-mono text-xs text-text shrink-0">{item.name}</span>
                </span>
                {dir && (
                  <span className="max-w-full truncate pl-[calc(1em+0.5rem)] text-xs text-text-muted">
                    {dir}
                  </span>
                )}
              </CommandItem>
            );
          })}
        </CommandList>
      </Command>
    </div>
  );
}

export function ChatPanel({
  piSessionId,
  timeline,
  turnQueue,
  isSessionBusy,
  isSessionCompacting,
  contextUsage,
  onSendMessage,
  onLoadPrevious,
  hasPreviousPage,
  isFetchingPreviousPage,
  streamId,
  streamName,
  streamType,
  streamHasWorktree = false,
  selectedModelId,
  selectedThinkingLevel,
  recoveryKind,
  messageInputDisabled,
}: ChatPanelProps) {
  useWhyDidYouRender("ChatPanel", {
    piSessionId,
    timeline,
    isSessionBusy,
    isSessionCompacting,
    streamId,
    recoveryKind,
    messageInputDisabled,
  });
  const { config, setConfig } = useUserConfig();
  const chatLayout = parsePanelLayout(config, CHAT_LAYOUT_KEY, CHAT_LAYOUT_DEFAULT);
  const { apiClient } = rootApi.useRouteContext();
  const queryClient = useQueryClient();
  const messageListRef = useRef<StreamsMessageListHandle>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const findPreviousFocusRef = useRef<HTMLElement | null>(null);
  const [findSessionId, setFindSessionId] = useState<string>();
  const [findHistorySessionId, setFindHistorySessionId] = useState<string>();
  const findOpen = findSessionId === piSessionId;
  const findHistoryRequested = findHistorySessionId === piSessionId;
  const findHistoryQuery = useQuery({
    ...conversationFindHistoryQueryOptions(piSessionId),
    enabled: findHistoryRequested,
  });
  const [findValue, setFindValue] = useState("");
  const [findSelection, setFindSelection] = useState({ query: "", matchIndex: 0 });
  const deferredFindValue = useDeferredValue(findValue);
  const completeFindTimeline = findHistoryRequested ? findHistoryQuery.data?.items : undefined;
  const mergedTimeline = useMemo(
    () => mergeFindTimeline(completeFindTimeline, timeline),
    [completeFindTimeline, timeline],
  );
  const conversationRows = useMemo(() => buildConversationRows(mergedTimeline), [mergedTimeline]);
  const findReady = Boolean(findHistoryQuery.data);
  const hasFindQuery = Boolean(deferredFindValue);
  const conversationFindIndex = useMemo(
    () =>
      findOpen && findReady && hasFindQuery ? buildConversationFindIndex(conversationRows) : [],
    [conversationRows, findOpen, findReady, hasFindQuery],
  );
  const findResults = useMemo(
    () =>
      findOpen && findReady
        ? findConversationMatches(conversationFindIndex, deferredFindValue)
        : EMPTY_CONVERSATION_FIND_RESULTS,
    [conversationFindIndex, deferredFindValue, findOpen, findReady],
  );
  const findMatchIndex = findSelection.query === deferredFindValue ? findSelection.matchIndex : 0;
  const selectedFindMatchIndex = findResults.matchCount
    ? findMatchIndex % findResults.matchCount
    : 0;
  const activeFindRowIndex = conversationFindRowAt(findResults, selectedFindMatchIndex);
  const { data: worktree } = useQuery(streamsWorktreeQueryOptions(piSessionId));
  const cwdAbsolute = worktree?.cwdAbsolute ?? null;
  const cwdShortcutLabel =
    useShortcutBindingLabel(SHORTCUT_ACTIONS.streamEditCurrentDirectory, { compact: true }) ||
    "c then d";
  const [cwdPickerOpen, setCwdPickerOpen] = useState(false);
  const [cwdPickerValue, setCwdPickerValue] = useState("@");
  const cwdPickerHeaderRef = useRef<HTMLDivElement>(null);
  const cwdPickerAnchorRef = useRef<HTMLSpanElement>(null);
  const cwdPickerButtonRef = useRef<HTMLButtonElement>(null);
  const cwdPickerRef = useRef<HTMLDivElement>(null);
  const [cwdPickerStyle, setCwdPickerStyle] = useState<CSSProperties>();
  const cwdPickerQuery = cwdPickerValue.replace(/^@/, "").trimStart();
  const { data: cwdPickerResult } = useQuery(
    directoryCompletionsQueryOptions(cwdPickerQuery, cwdPickerOpen, { directoriesOnly: true }),
  );
  const cwdPickerItems = cwdPickerResult?.items ?? [];

  const switchCwdMutation = useMutation({
    mutationFn: (cwd: string) => {
      if (!streamId) throw new Error("No swimlane selected");
      return setStreamCwd({ data: { streamId, cwd } });
    },
    onSuccess: async () => {
      toast.success("cwd switched");
      setCwdPickerOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["streams-worktree", piSessionId] }),
        queryClient.invalidateQueries({ queryKey: ["status"] }),
        queryClient.invalidateQueries({ queryKey: ["directory-completions"] }),
      ]);
    },
    onError: (error) => {
      toast.error(
        `Failed to switch cwd: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });

  const commitCwdPicker = useCallback(() => {
    const value = cwdPickerValue.replace(/^@/, "").trim();
    switchCwdMutation.mutate(value);
  }, [cwdPickerValue, switchCwdMutation.mutate]);

  const drillCwdPicker = useCallback((item: DirectoryCompletionItem) => {
    setCwdPickerValue(`@${item.insertText}`);
  }, []);

  const openCwdPicker = useCallback(() => {
    setCwdPickerValue("@");
    setCwdPickerOpen(true);
  }, []);

  useLayoutEffect(() => {
    if (!cwdPickerOpen) return;

    const updatePickerStyle = () => {
      const header = cwdPickerHeaderRef.current;
      const anchor = cwdPickerAnchorRef.current;
      if (!header || !anchor) return;

      const headerRect = header.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      const width = Math.min(28 * 16, headerRect.width);
      const anchorLeft = anchorRect.left - headerRect.left;
      const left = Math.max(0, Math.min(anchorLeft, headerRect.width - width));

      setCwdPickerStyle({ left, width });
    };

    updatePickerStyle();

    const header = cwdPickerHeaderRef.current;
    const resizeObserver = new ResizeObserver(updatePickerStyle);
    if (header) resizeObserver.observe(header);
    window.addEventListener("resize", updatePickerStyle);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updatePickerStyle);
    };
  }, [cwdPickerOpen]);

  useEffect(() => {
    if (!cwdPickerOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (cwdPickerAnchorRef.current?.contains(target) || cwdPickerRef.current?.contains(target)) {
        return;
      }
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      setCwdPickerOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [cwdPickerOpen]);

  const pendingPostedScrollClientMessageIdsRef = useRef<Set<string>>(new Set());
  const interruptMutation = useMutation({
    mutationFn: () => apiClient.interruptPiSession(piSessionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["status"] }),
  });
  const removeQueuedTurnMutation = useMutation({
    mutationFn: (itemId: string) => apiClient.removeTurnQueueItem(piSessionId, itemId),
    onSuccess: (snapshot, itemId) => {
      if (snapshot.removed) {
        const webClientId = turnQueue.items.find((item) => item.id === itemId)?.webClientId;
        if (webClientId) pendingPostedScrollClientMessageIdsRef.current.delete(webClientId);
      } else if (snapshot.accepting) {
        toast.info("Turn is already being accepted by Pi");
      } else {
        toast.info("Turn was already accepted or is no longer queued");
      }
      applyTurnQueueSnapshot(queryClient, piSessionId, snapshot);
    },
    onError: (error) => {
      toast.error(`Failed to remove queued turn: ${String(error)}`);
    },
  });

  const recoverMutation = useReopenStream();

  const [isSending, setIsSending] = useState(false);
  const [pruneTarget, setPruneTarget] = useState<string | null>(null);
  useEffect(() => {
    pendingPostedScrollClientMessageIdsRef.current.clear();
  }, [piSessionId]);
  const pruneMutation = useMutation({
    mutationFn: (entryId: string) => apiClient.pruneStreamHistory(piSessionId, entryId),
    onSuccess: () => {
      void invalidateHistorySnapshot(queryClient, piSessionId);
    },
    onError: (error) => {
      toast.error(
        `Failed to delete messages: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });

  const forkMutation = useMutation({
    mutationFn: (entryId: string) => apiClient.forkStream(piSessionId, entryId),
    onSuccess: (result) => {
      toast.success(`Forked into new swimlane: ${result.streamName}`);
    },
    onError: (error) => {
      toast.error(
        `Failed to fork swimlane: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });

  const retryConversationFind = useCallback(() => {
    findInputRef.current?.focus();
    void findHistoryQuery.refetch();
  }, [findHistoryQuery.refetch]);

  const openConversationFind = useCallback(() => {
    if (!findOpen && document.activeElement instanceof HTMLElement) {
      findPreviousFocusRef.current = document.activeElement;
    }
    setFindSessionId(piSessionId);
    if (findOpen) {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    }
  }, [findOpen, piSessionId]);

  const closeConversationFind = useCallback(() => {
    setFindSessionId(undefined);
    const previousFocus = findPreviousFocusRef.current;
    findPreviousFocusRef.current = null;
    requestAnimationFrame(() => {
      if (previousFocus?.isConnected) previousFocus.focus();
      else focusComposerInput();
    });
  }, []);

  const moveConversationFind = useCallback(
    (delta: -1 | 1) => {
      setFindSelection((current) => ({
        query: deferredFindValue,
        matchIndex: moveConversationFindSelection(
          current.query === deferredFindValue ? current.matchIndex : 0,
          findResults.matchCount,
          delta,
        ),
      }));
    },
    [deferredFindValue, findResults.matchCount],
  );

  const changeConversationFindValue = useCallback(
    (value: string) => {
      setFindValue(value);
      if (value) setFindHistorySessionId(piSessionId);
    },
    [piSessionId],
  );

  useLayoutEffect(() => {
    if (!findOpen) return;
    findInputRef.current?.focus();
    findInputRef.current?.select();
  }, [findOpen]);

  useEffect(() => {
    setFindSessionId(undefined);
    setFindHistorySessionId(undefined);
    setFindValue("");
    setFindSelection({ query: "", matchIndex: 0 });
    findPreviousFocusRef.current = null;
  }, [piSessionId]);

  useEffect(() => {
    if (!findOpen) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || hasBlockingSurface()) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      closeConversationFind();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [closeConversationFind, findOpen]);

  useEffect(() => {
    return registerShortcutHandlers([
      {
        actionId: SHORTCUT_ACTIONS.streamEditCurrentDirectory,
        priority: 20,
        handler: () => {
          if (!streamId || !cwdAbsolute) return false;
          openCwdPicker();
          return true;
        },
      },
      {
        actionId: SHORTCUT_ACTIONS.conversationFind,
        priority: 20,
        handler: (event) => {
          if (event.isComposing || hasBlockingSurface()) return false;
          if (findOpen && (event.metaKey || event.ctrlKey)) return false;
          openConversationFind();
          return true;
        },
      },
    ]);
  }, [cwdAbsolute, findOpen, openConversationFind, openCwdPicker, streamId]);

  useLayoutEffect(() => {
    const pendingScrollIds = pendingPostedScrollClientMessageIdsRef.current;
    let shouldScrollToPostedMessage = false;

    for (const item of timeline) {
      if (item.kind !== "message") continue;
      const message = item as ChatTimelineMessage;
      if (message.role === "user" && pendingScrollIds.delete(message.id)) {
        shouldScrollToPostedMessage = true;
      }
    }

    if (shouldScrollToPostedMessage) messageListRef.current?.scrollToEnd();
  }, [timeline]);

  const handlePruneRequested = useCallback((entryId: string) => {
    setPruneTarget(entryId);
  }, []);

  const handleForkRequested = useCallback(
    (entryId: string) => {
      forkMutation.mutate(entryId);
    },
    [forkMutation],
  );

  const confirmPrune = useCallback(() => {
    const entryId = pruneTarget;
    if (!entryId) return;
    pruneMutation.mutate(entryId, {
      onSettled: () => setPruneTarget(null),
    });
  }, [pruneTarget, pruneMutation]);

  const handleSubmit = useCallback(
    async (text: string, images?: ImageAttachment[]) => {
      if (messageInputDisabled || (!text && !images?.length)) return;

      const clientMessageId = crypto.randomUUID();
      pendingPostedScrollClientMessageIdsRef.current.add(clientMessageId);
      const displayText = text || "(image)";
      setIsSending(true);

      try {
        await onSendMessage(displayText, { images, clientMessageId });
      } catch (error) {
        pendingPostedScrollClientMessageIdsRef.current.delete(clientMessageId);
        toast.error("Failed to send message");
        console.error("handleSubmit send failed:", error);
        throw error;
      } finally {
        setIsSending(false);
        void queryClient.invalidateQueries({ queryKey: ["status"] });
      }
    },
    [messageInputDisabled, onSendMessage, queryClient],
  );

  const effectiveRecoveryKind = recoveryKind && streamId ? recoveryKind : undefined;

  const inputHoverButtons = useMemo<MessageInputHoverButton[]>(() => {
    if (!streamId) {
      return [
        {
          id: "clear-session",
          label: "clear session",
          insertText: "/clear ",
        },
        {
          id: "compact-session",
          label: "compact",
          insertText: "/compact ",
        },
      ];
    }
    if (streamType === "defaultStream") {
      return [
        {
          id: "compact-session",
          label: "compact",
          insertText: "/compact ",
        },
      ];
    }

    const buttons: MessageInputHoverButton[] = [
      streamHasWorktree
        ? {
            id: "close-merge",
            label: "close (merge)",
            insertText:
              "Ship it (run close_swimlane with the merge option, which commits worktree changes, merges into this repo's flitterbot configured base branch, pushes base branch, then closes this stream)",
          }
        : {
            id: "close-swimlane",
            label: "close swimlane",
            insertText: "close swimlane with the no-op option",
          },
    ];

    if (streamHasWorktree) {
      buttons.push({
        id: "close-no-git-ops",
        label: "close (no git ops)",
        insertText: "close swimlane with the no-op option (i.e. no bundled git operations)",
      });
      if (worktree?.worktreePath && worktree.branch && worktree.baseBranch) {
        buttons.push({
          id: "merge-base-branch",
          label: "merge into base",
          insertText: `Pls commit all changes in ${worktree.worktreePath}, then merge the current worktree branch ${worktree.branch} (using bash tool) into branch "${worktree.baseBranch}".`,
        });
      }
    }

    buttons.push({ id: "compact-session", label: "compact", insertText: "/compact " });
    return buttons;
  }, [
    streamHasWorktree,
    streamId,
    streamType,
    worktree?.baseBranch,
    worktree?.branch,
    worktree?.worktreePath,
  ]);

  return (
    <div className="flex flex-col h-full">
      <div
        ref={cwdPickerHeaderRef}
        className="relative flex items-center py-2 pr-4 pl-6 border-b border-border shrink-0 min-h-11 gap-3"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 @container">
          <h1 className="min-w-0 truncate text-sm font-semibold text-text">
            {streamName ?? "flitterbot"}
          </h1>
          {worktree?.cwd && cwdAbsolute && (
            <>
              <span className="text-text-muted text-sm shrink-0">|</span>
              <span ref={cwdPickerAnchorRef} className="relative flex min-w-0 items-center gap-1">
                <button
                  ref={cwdPickerButtonRef}
                  type="button"
                  onClick={openCwdPicker}
                  disabled={!streamId}
                  aria-label={`Edit path. Current path: ${cwdAbsolute}`}
                  aria-expanded={cwdPickerOpen}
                  className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-center gap-1 rounded bg-background-muted px-1.5 py-1 text-left text-xs text-text-muted transition-colors hover:bg-background-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-pop disabled:cursor-default disabled:hover:bg-background-muted disabled:hover:text-text-muted"
                  title={streamId ? `Switch cwd from ${cwdAbsolute}` : cwdAbsolute}
                >
                  <FolderPenIcon className="size-3.5" aria-hidden="true" />
                  <span className="min-w-0 truncate text-text" aria-hidden="true">
                    {worktree.cwd}
                  </span>
                </button>
                <ShortcutHint
                  label={cwdShortcutLabel}
                  className="hidden shrink-0 @[30rem]:inline-grid"
                  aria-hidden="true"
                />
              </span>
            </>
          )}
        </div>
        <ContextTicker usage={contextUsage} />
        <CwdPicker
          pickerRef={cwdPickerRef}
          pickerStyle={cwdPickerStyle}
          open={cwdPickerOpen}
          value={cwdPickerValue}
          items={cwdPickerItems}
          pending={switchCwdMutation.isPending}
          onValueChange={setCwdPickerValue}
          onDrill={drillCwdPicker}
          onCommit={commitCwdPicker}
          onEscape={() => {
            setCwdPickerOpen(false);
            cwdPickerButtonRef.current?.focus();
          }}
        />
      </div>

      <PanelGroup
        orientation="vertical"
        className="flex-1 min-h-0"
        style={{ overflow: "visible" }}
        defaultLayout={chatLayout}
        onLayoutChanged={(layout: PanelLayout) =>
          setConfig(CHAT_LAYOUT_KEY, JSON.stringify(layout))
        }
      >
        <Panel id="feed" defaultSize="85%" minSize="20%" style={{ overflow: "hidden" }}>
          <div className="relative isolate h-full">
            <StreamsMessageList
              key={piSessionId} // remount per session: re-arms initial pin
              ref={messageListRef}
              piSessionId={piSessionId}
              rows={conversationRows}
              activeFindRowIndex={activeFindRowIndex}
              onPruneRequested={handlePruneRequested}
              onForkRequested={handleForkRequested}
              isSessionBusy={isSessionBusy}
              onLoadPrevious={onLoadPrevious}
              hasPreviousPage={hasPreviousPage && !findHistoryQuery.data}
              isFetchingPreviousPage={isFetchingPreviousPage}
            />
            {findOpen && (
              <ConversationFindBar
                inputRef={findInputRef}
                value={findValue}
                matchIndex={selectedFindMatchIndex}
                matchCount={findResults.matchCount}
                loading={findHistoryQuery.isFetching && !findHistoryQuery.data}
                error={findHistoryQuery.error}
                onValueChange={changeConversationFindValue}
                onMove={moveConversationFind}
                onRetry={retryConversationFind}
                onClose={closeConversationFind}
              />
            )}
          </div>
        </Panel>

        <HorizontalResizeHandle />

        <Panel id="input" defaultSize="15%" minSize="9%" style={{ overflow: "visible" }}>
          <Dialog
            open={pruneTarget !== null}
            onOpenChange={(open) => !open && setPruneTarget(null)}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete from here?</DialogTitle>
                <DialogDescription>
                  This removes this user message and every turn after it from both the live agent
                  context and the on-disk transcript. The agent will not remember the pruned turns.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose
                  render={<Button variant="subtle" />}
                  disabled={pruneMutation.isPending}
                >
                  Cancel
                </DialogClose>
                <Button
                  variant="danger"
                  autoFocus
                  onClick={confirmPrune}
                  disabled={pruneMutation.isPending}
                >
                  {pruneMutation.isPending ? "Deleting…" : "Delete"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <MessageInput
            key={streamId ?? piSessionId ?? "__chat__"}
            draftKey={streamId ?? piSessionId ?? "__chat__"}
            isSending={isSending}
            disabled={messageInputDisabled}
            onSubmit={handleSubmit}
            fillHeight
            autoFocus
            streamId={streamId}
            modelSelectorPiSessionId={piSessionId}
            selectedModelId={selectedModelId}
            selectedThinkingLevel={selectedThinkingLevel}
            isSessionBusy={isSessionBusy}
            isCompacting={isSessionCompacting}
            onInterrupt={() => interruptMutation.mutate()}
            isInterruptPending={interruptMutation.isPending}
            recoveryKind={effectiveRecoveryKind}
            onRecover={() => {
              if (streamId && effectiveRecoveryKind) {
                recoverMutation.mutate({ streamId, recoveryKind: effectiveRecoveryKind });
              }
            }}
            hoverButtons={inputHoverButtons}
            internalCommandScope={
              !streamId
                ? "surface"
                : streamType === "defaultStream"
                  ? "default-stream"
                  : "work-stream"
            }
            isRecoverPending={recoverMutation.isPending}
            queuedTurns={turnQueue.items}
            onRemoveQueuedTurn={(itemId) => removeQueuedTurnMutation.mutate(itemId)}
            removingQueuedTurnId={
              removeQueuedTurnMutation.isPending ? removeQueuedTurnMutation.variables : undefined
            }
          />
        </Panel>
      </PanelGroup>
    </div>
  );
}
