import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Layout as PanelLayout } from "react-resizable-panels";
import { toast } from "sonner";
import { Button } from "~/components/common/button";
import { ShortcutHint } from "~/components/common/kbd";
import { MessageInput, type MessageInputHoverButton } from "~/components/common/message-input";
import { HorizontalResizeHandle, Panel, PanelGroup } from "~/components/common/resizable";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "~/components/ui/command";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { useAgentMessages } from "~/hooks/use-agent-messages";
import { useCopyToClipboard } from "~/hooks/use-copy-to-clipboard";
import { useStickToBottom } from "~/hooks/use-stick-to-bottom";
import { parsePanelLayout, useUserConfig } from "~/hooks/use-user-config";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { activeToolStore } from "~/lib/active-tool-store";
import { streamingUiDebug } from "~/lib/debug-log";
import {
  registerShortcutHandlers,
  SHORTCUT_ACTIONS,
  useShortcutBindingLabel,
} from "~/lib/global-shortcuts";
import { directoryCompletionsQueryOptions, streamsWorktreeQueryOptions } from "~/lib/queries";
import { streamingPerf } from "~/lib/streaming-perf";
import { streamingStore } from "~/lib/streaming-store";
import type {
  ChatTimelineItem,
  ChatTimelineMessage,
  DirectoryCompletionItem,
  ImageAttachment,
  StatusResponse,
  ThinkingLevel,
} from "~/lib/types";
import { setStreamCwd } from "~/server/streams";
import { StreamsMessageList, type StreamsMessageListHandle } from "./streams-message-list";

const CHAT_LAYOUT_KEY = "panel:chat-layout";
const CHAT_LAYOUT_DEFAULT: Record<string, number> = { feed: 85, input: 15 };

type ChatPanelProps = {
  piSessionId: string;
  timeline: ChatTimelineItem[];
  isSessionBusy: boolean;
  onSendMessage: (
    text: string,
    options?: { images?: ImageAttachment[]; clientMessageId?: string },
  ) => Promise<void>;
  streamId?: string;
  streamName?: string;
  streamHasWorktree?: boolean;
  selectedModelId?: string;
  selectedThinkingLevel?: ThinkingLevel;
  recoveryKind?: "closed" | "dead";
};

function QueuedBusyOverlay({ text }: { text: string }) {
  if (!text) return null;

  return (
    <div className="pointer-events-none absolute inset-x-6 bottom-3 z-20 flex justify-end">
      <div className="max-w-[min(44rem,100%)] rounded-lg border border-border/80 bg-background/95 px-3 py-2 text-xs shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/85">
        <div className="font-medium text-muted-foreground">Queued:</div>
        <div className="mt-1 max-h-32 overflow-hidden whitespace-pre-wrap break-words text-foreground/90">
          {text}
        </div>
      </div>
    </div>
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
  open: boolean;
  value: string;
  items: DirectoryCompletionItem[];
  pending: boolean;
  onValueChange: (value: string) => void;
  onDrill: (item: DirectoryCompletionItem) => void;
  onCommit: () => void;
  onEscape: () => void;
}) {
  const collapseAndBlur = useCallback(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    onEscape();
  }, [onEscape]);

  const handleValueChange = useCallback(
    (nextValue: string) => {
      if (!nextValue) {
        collapseAndBlur();
        return;
      }
      onValueChange(nextValue);
    },
    [collapseAndBlur, onValueChange],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
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
    [items.length, onCommit, onEscape, value],
  );

  if (!open) return null;

  return (
    <div
      ref={pickerRef}
      className="absolute left-0 top-full z-50 mt-1 w-[min(36rem,calc(100vw-3rem))] rounded-lg border border-border bg-background p-1 shadow-lg"
    >
      <Command
        shouldFilter={false}
        loop
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
            className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            title="switch cwd to this path"
          >
            →
          </button>
        </div>
        <CommandList className="max-h-80 overflow-y-auto p-1">
          {items.length === 0 && (
            <CommandEmpty className="px-3 py-2 text-sm text-muted-foreground">
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
                className="!flex !flex-col !items-start gap-0 rounded-md px-3 py-1.5 text-sm cursor-pointer data-[selected=true]:bg-muted [&>svg]:!hidden"
              >
                <span className="flex items-baseline gap-2 min-w-0">
                  <span className="shrink-0">📁</span>
                  <span className="font-mono text-xs text-foreground shrink-0">{item.name}</span>
                </span>
                {dir && (
                  <span className="max-w-full truncate pl-[calc(1em+0.5rem)] text-xs text-muted-foreground">
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

function markPiSessionBusy(
  status: StatusResponse | undefined,
  piSessionId: string,
): StatusResponse | undefined {
  if (!status?.piAgent) return status;

  const defaultSession = status.piAgent.default;
  if (defaultSession?.piSessionId === piSessionId) {
    if (defaultSession.busy) return status;
    return {
      ...status,
      piAgent: {
        ...status.piAgent,
        default: { ...defaultSession, busy: true },
      },
    } satisfies StatusResponse;
  }

  const orchestrators = status.piAgent.orchestrators;
  const index = orchestrators?.findIndex((session) => session.piSessionId === piSessionId) ?? -1;
  if (!orchestrators || index < 0 || orchestrators[index]?.busy) return status;

  return {
    ...status,
    piAgent: {
      ...status.piAgent,
      orchestrators: orchestrators.map((session, sessionIndex) =>
        sessionIndex === index ? { ...session, busy: true } : session,
      ),
    },
  } satisfies StatusResponse;
}

export function ChatPanel({
  piSessionId,
  timeline,
  isSessionBusy,
  onSendMessage,
  streamId,
  streamName,
  streamHasWorktree = false,
  selectedModelId,
  selectedThinkingLevel,
  recoveryKind,
}: ChatPanelProps) {
  useWhyDidYouRender("ChatPanel", {
    piSessionId,
    timeline,
    isSessionBusy,
    streamId,
    recoveryKind,
  });
  const { config, setConfig } = useUserConfig();
  const chatLayout = parsePanelLayout(config, CHAT_LAYOUT_KEY, CHAT_LAYOUT_DEFAULT);
  const rootApi = getRouteApi("__root__");
  const { apiClient } = rootApi.useRouteContext();
  const queryClient = useQueryClient();
  const messageListRef = useRef<StreamsMessageListHandle>(null);
  const { data: worktree } = useQuery(streamsWorktreeQueryOptions(piSessionId));
  const cwdAbsolute = worktree?.cwdAbsolute ?? null;
  const cwdCopy = useCopyToClipboard(600);
  const cwdShortcutLabel =
    useShortcutBindingLabel(SHORTCUT_ACTIONS.streamCopyCurrentDirectory, { compact: true }) ||
    "c then d";
  const [cwdPickerOpen, setCwdPickerOpen] = useState(false);
  const [cwdPickerValue, setCwdPickerValue] = useState("@");
  const cwdPickerAnchorRef = useRef<HTMLSpanElement>(null);
  const cwdPickerRef = useRef<HTMLDivElement>(null);
  const cwdPickerQuery = cwdPickerValue.replace(/^@/, "").trimStart();
  const { data: cwdPickerResult } = useQuery(
    directoryCompletionsQueryOptions(cwdPickerQuery, cwdPickerOpen, { directoriesOnly: true }),
  );
  const cwdPickerItems = cwdPickerResult?.items ?? [];

  const switchCwdMutation = useMutation({
    mutationFn: (cwd: string) => {
      if (!streamId) throw new Error("No stream selected");
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

  const interruptMutation = useMutation({
    mutationFn: () => apiClient.interruptPiSession(piSessionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["status"] }),
  });

  const recoverMutation = useMutation({
    mutationFn: () => apiClient.reopenStream(streamId!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["status"] }),
    onError: (error) => {
      toast.error(
        `Failed to ${recoveryKind === "dead" ? "recover" : "reopen"}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    },
  });

  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([]);

  const [isSending, setIsSending] = useState(false);
  const [busyQueuedText, setBusyQueuedText] = useState("");
  const busyQueuedTextRef = useRef("");
  const busyQueuedClearClientMessageIdRef = useRef<string | null>(null);
  const pendingPostedScrollClientMessageIdsRef = useRef<Set<string>>(new Set());
  const [pruneTarget, setPruneTarget] = useState<string | null>(null);
  const agentMessages = useAgentMessages(timeline);

  const pruneMutation = useMutation({
    mutationFn: (entryId: string) => apiClient.pruneStreamHistory(piSessionId, entryId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["streams-history", piSessionId] });
    },
    onError: (error) => {
      toast.error(
        `Failed to delete messages: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });

  const clearBusyQueuedText = useCallback(() => {
    busyQueuedTextRef.current = "";
    busyQueuedClearClientMessageIdRef.current = null;
    setBusyQueuedText("");
  }, []);

  const appendBusyQueuedText = useCallback((text: string) => {
    setBusyQueuedText((previous) => {
      const next = previous ? `${previous}\n${text}` : text;
      busyQueuedTextRef.current = next;
      return next;
    });
  }, []);

  const { viewportRef, scrollToBottom, isAtBottomRef, engageAndScroll } = useStickToBottom({
    initialScrollWhen: agentMessages.length > 0,
    initialScrollKey: piSessionId,
  });

  useEffect(() => {
    clearBusyQueuedText();
  }, [clearBusyQueuedText, piSessionId]);

  useEffect(() => {
    return registerShortcutHandlers([
      {
        actionId: SHORTCUT_ACTIONS.streamCopyCurrentDirectory,
        priority: 20,
        handler: () => {
          if (!cwdAbsolute) return false;
          void cwdCopy.copy(cwdAbsolute).catch(() => toast.error("Failed to copy"));
          return true;
        },
      },
    ]);
  }, [cwdAbsolute, cwdCopy.copy]);

  useEffect(() => {
    const clientMessageId = busyQueuedClearClientMessageIdRef.current;
    const pendingScrollIds = pendingPostedScrollClientMessageIdsRef.current;
    let shouldScrollToPostedMessage = false;

    for (const item of timeline) {
      if (item.kind !== "message") continue;
      const message = item as ChatTimelineMessage;
      if (message.role !== "user" || !message.clientMessageId) continue;

      if (busyQueuedText && message.clientMessageId === clientMessageId) {
        clearBusyQueuedText();
      }
      if (pendingScrollIds.delete(message.clientMessageId)) {
        shouldScrollToPostedMessage = true;
      }
    }

    if (shouldScrollToPostedMessage) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          engageAndScroll();
        });
      });
    }
  }, [busyQueuedText, clearBusyQueuedText, engageAndScroll, timeline]);

  const handlePruneRequested = useCallback((entryId: string) => {
    setPruneTarget(entryId);
  }, []);

  const confirmPrune = useCallback(() => {
    const entryId = pruneTarget;
    if (!entryId) return;
    pruneMutation.mutate(entryId, {
      onSettled: () => setPruneTarget(null),
    });
  }, [pruneTarget, pruneMutation]);

  const handleMessagesRendered = useCallback(() => {
    if (!isAtBottomRef.current) return;
    const scrollToken = streamingPerf.beginScroll();
    scrollToBottom();
    streamingPerf.endScroll(scrollToken);
  }, [isAtBottomRef, scrollToBottom]);

  useEffect(() => {
    streamingStore.onStreamingDelta(
      piSessionId,
      (text, thinking, isThinkingStreaming, messageId) => {
        if (messageId != null) {
          messageListRef.current?.updateStreaming(
            {
              role: "assistant",
              content: [
                ...(thinking != null ? [{ type: "thinking" as const, thinking }] : []),
                ...(text ? [{ type: "text" as const, text }] : []),
              ],
              api: "openai-responses",
              provider: "openai",
              model: "",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop",
              timestamp: Date.now(),
            },
            isThinkingStreaming,
          );
        } else {
          streamingUiDebug(
            "[debug][ChatPanel] clearStreaming() — messageId=null, streaming store fired end-of-stream for session=%s",
            piSessionId,
          );
          messageListRef.current?.clearStreaming();
        }
      },
    );

    streamingStore.onCommit(piSessionId, (agentMessages) => {
      messageListRef.current?.commitStreaming(agentMessages);
    });
    streamingStore.onToolResultCommit(piSessionId, (agentMessage) => {
      messageListRef.current?.commitToolResult(agentMessage);
    });

    activeToolStore.onUpdate(piSessionId, (event) => {
      if (event.type === "clear_all") {
        messageListRef.current?.clearActiveTools();
        return;
      }
      messageListRef.current?.applyActiveToolState(event.state);
      handleMessagesRendered();
    });
    messageListRef.current?.setActiveTools(activeToolStore.getSnapshot(piSessionId));

    return () => {
      streamingStore.offStreamingDelta(piSessionId);
      streamingStore.offCommit(piSessionId);
      streamingStore.offToolResultCommit(piSessionId);
      activeToolStore.offUpdate(piSessionId);
      messageListRef.current?.clearStreaming();
      messageListRef.current?.clearActiveTools();
    };
  }, [piSessionId, handleMessagesRendered]);

  const addImageFiles = useCallback((files: FileList | File[]) => {
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!imageFiles.length) return;
    for (const file of imageFiles) {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(",")[1];
        if (base64) {
          setPendingImages((prev) => [...prev, { data: base64, mimeType: file.type }]);
        }
      };
      reader.readAsDataURL(file);
    }
  }, []);

  const removeImage = useCallback((index: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const pendingImagesRef = useRef(pendingImages);
  useEffect(() => {
    pendingImagesRef.current = pendingImages;
  });

  const handleSubmit = useCallback(
    async (text: string) => {
      const images = pendingImagesRef.current.length ? [...pendingImagesRef.current] : undefined;
      if (!text && !images?.length) return;

      const clientMessageId = crypto.randomUUID();
      pendingPostedScrollClientMessageIdsRef.current.add(clientMessageId);
      const displayText = text || "(image)";
      const queueBehindBusy = isSessionBusy || busyQueuedTextRef.current.length > 0;

      if (queueBehindBusy) {
        if (images?.length) return;

        setIsSending(true);
        try {
          await onSendMessage(displayText, { clientMessageId });
          busyQueuedClearClientMessageIdRef.current = clientMessageId;
          appendBusyQueuedText(displayText);
          setPendingImages([]);
        } catch (error) {
          pendingPostedScrollClientMessageIdsRef.current.delete(clientMessageId);
          toast.error("Failed to queue message");
          console.error("handleSubmit queue failed:", error);
        } finally {
          setIsSending(false);
        }
        return;
      }

      queryClient.setQueryData<StatusResponse>(["status"], (status) =>
        markPiSessionBusy(status, piSessionId),
      );

      const now = new Date().toISOString();
      const optimistic: ChatTimelineMessage = {
        id: clientMessageId,
        kind: "message",
        role: "user",
        content: displayText,
        source: "web",
        createdAt: now,
        ...(images?.length ? { images } : {}),
      };
      const cacheKey = ["streams-history", piSessionId, "agent"] as const;
      queryClient.setQueryData<ChatTimelineItem[]>(cacheKey, (old) => [...(old ?? []), optimistic]);
      engageAndScroll();

      setIsSending(true);

      try {
        await onSendMessage(displayText, { images, clientMessageId });
        setPendingImages([]);
      } catch (error) {
        pendingPostedScrollClientMessageIdsRef.current.delete(clientMessageId);
        queryClient.setQueryData<ChatTimelineItem[]>(cacheKey, (old) =>
          (old ?? []).filter((item) => item.id !== clientMessageId),
        );
        queryClient.invalidateQueries({ queryKey: ["status"] });
        toast.error("Failed to send message");
        console.error("handleSubmit send failed:", error);
      } finally {
        setIsSending(false);
      }
    },
    [appendBusyQueuedText, engageAndScroll, isSessionBusy, onSendMessage, piSessionId, queryClient],
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
      ];
    }
    if (streamHasWorktree) {
      const buttons: MessageInputHoverButton[] = [
        { id: "close-merge", label: "close (merge)", insertText: "ship it" },
        {
          id: "close-no-git-ops",
          label: "close (no git ops)",
          insertText: "close stream with the no-op option",
        },
      ];
      if (worktree?.worktreePath && worktree.branch && worktree.baseBranch) {
        buttons.push({
          id: "merge-base-branch",
          label: "merge into base",
          insertText: `Pls commit all changes in ${worktree.worktreePath}, then merge the current worktree branch ${worktree.branch} (using bash tool) into branch "${worktree.baseBranch}".`,
        });
      }
      return buttons;
    }
    return [
      {
        id: "close-stream",
        label: "close stream",
        insertText: "close stream with the no-op option",
      },
    ];
  }, [streamHasWorktree, streamId, worktree?.baseBranch, worktree?.branch, worktree?.worktreePath]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center px-6 py-2 border-b border-border shrink-0 min-h-11 gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <h1 className="text-sm font-semibold text-foreground truncate">
            {streamName ?? "flitterbot"}
          </h1>
          {worktree?.cwd && cwdAbsolute && (
            <>
              <span className="text-muted-foreground/50 text-sm shrink-0">|</span>
              <span ref={cwdPickerAnchorRef} className="relative flex items-center gap-1 min-w-0">
                <button
                  type="button"
                  onClick={streamId ? openCwdPicker : undefined}
                  disabled={!streamId}
                  className="inline-block max-w-full truncate rounded bg-muted/60 px-1.5 py-0.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted disabled:cursor-default disabled:hover:bg-muted/60"
                  title={streamId ? `switch cwd from ${cwdAbsolute}` : cwdAbsolute}
                >
                  <span>{worktree.cwd}</span>
                </button>
                <CwdPicker
                  pickerRef={cwdPickerRef}
                  open={cwdPickerOpen}
                  value={cwdPickerValue}
                  items={cwdPickerItems}
                  pending={switchCwdMutation.isPending}
                  onValueChange={setCwdPickerValue}
                  onDrill={drillCwdPicker}
                  onCommit={commitCwdPicker}
                  onEscape={() => setCwdPickerOpen(false)}
                />
                {cwdCopy.copied ? (
                  <span className="text-muted-foreground/50 text-[10px]">Copied!</span>
                ) : (
                  <ShortcutHint label={cwdShortcutLabel} />
                )}
              </span>
            </>
          )}
        </div>
      </div>

      <PanelGroup
        orientation="vertical"
        className="flex-1 min-h-0"
        defaultLayout={chatLayout}
        onLayoutChanged={(layout: PanelLayout) =>
          setConfig(CHAT_LAYOUT_KEY, JSON.stringify(layout))
        }
      >
        <Panel id="feed" defaultSize="85%" minSize="20%">
          <div className="relative h-full">
            <div
              ref={viewportRef}
              data-scroll-container="main"
              className="h-full overflow-auto px-6 py-4 space-y-3"
            >
              <StreamsMessageList
                ref={messageListRef}
                messages={agentMessages}
                onMessagesRendered={handleMessagesRendered}
                onPruneRequested={handlePruneRequested}
                isSessionBusy={isSessionBusy}
              />
            </div>
            <QueuedBusyOverlay text={busyQueuedText} />
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
                  render={<Button variant="outline" />}
                  disabled={pruneMutation.isPending}
                >
                  Cancel
                </DialogClose>
                <Button
                  variant="destructive"
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
            onSubmit={handleSubmit}
            pendingImages={pendingImages}
            onAddImages={addImageFiles}
            onRemoveImage={removeImage}
            fillHeight
            autoFocus
            streamId={streamId}
            modelSelectorPiSessionId={piSessionId}
            selectedModelId={selectedModelId}
            selectedThinkingLevel={selectedThinkingLevel}
            isSessionBusy={isSessionBusy}
            attachmentsDisabled={busyQueuedText.length > 0}
            onInterrupt={() => interruptMutation.mutate()}
            isInterruptPending={interruptMutation.isPending}
            recoveryKind={effectiveRecoveryKind}
            onRecover={() => recoverMutation.mutate()}
            hoverButtons={inputHoverButtons}
            internalCommandScope={streamId ? "work-stream" : "default-stream"}
            isRecoverPending={recoverMutation.isPending}
          />
        </Panel>
      </PanelGroup>
    </div>
  );
}
