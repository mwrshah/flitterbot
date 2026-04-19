import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Button } from "~/components/common/button";
import { MessageInput } from "~/components/common/message-input";
import { HorizontalResizeHandle, Panel, PanelGroup } from "~/components/common/resizable";
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
import { useStickToBottom } from "~/hooks/use-stick-to-bottom";
import { parsePanelLayout, useUserConfig } from "~/hooks/use-user-config";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { activeToolStore } from "~/lib/active-tool-store";
import { INTERNAL_COMMANDS } from "~/lib/internal-commands";
import { streamsWorktreeQueryOptions } from "~/lib/queries";
import { streamingPerf } from "~/lib/streaming-perf";
import { streamingStore } from "~/lib/streaming-store";
import type { ChatTimelineItem, ImageAttachment } from "~/lib/types";
import { StreamsMessageList, type StreamsMessageListHandle } from "./streams-message-list";

const emptySubscribe = () => () => {};
const useIsClient = () =>
  useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );

const CHAT_LAYOUT_KEY = "panel:chat-layout";
const CHAT_LAYOUT_DEFAULT: Record<string, number> = { feed: 85, input: 15 };

type ChatPanelProps = {
  piSessionId: string;
  timeline: ChatTimelineItem[];
  isSessionBusy: boolean;
  onSendMessage: (text: string, images?: ImageAttachment[]) => Promise<void>;
  streamId?: string;
  streamName?: string;
  /** Recovery action to offer in the header, if any:
   *  - 'closed' → stream is closed; offer "Reopen"
   *  - 'dead'   → stream is open but pi-session ended/crashed; offer "Recover" */
  recoveryKind?: "closed" | "dead";
};

export function ChatPanel({
  piSessionId,
  timeline,
  isSessionBusy,
  onSendMessage,
  streamId,
  streamName,
  recoveryKind,
}: ChatPanelProps) {
  useWhyDidYouRender("ChatPanel", {
    piSessionId,
    timeline,
    isSessionBusy,
    streamId,
    recoveryKind,
  });
  const isClient = useIsClient();
  const { config, setConfig } = useUserConfig();
  const chatLayout = parsePanelLayout(config, CHAT_LAYOUT_KEY, CHAT_LAYOUT_DEFAULT);
  const rootApi = getRouteApi("__root__");
  const { apiClient } = rootApi.useRouteContext();
  const queryClient = useQueryClient();
  const messageListRef = useRef<StreamsMessageListHandle>(null);
  const { data: skillsData } = useQuery({
    queryKey: ["skills"],
    queryFn: () => apiClient.listSkills(),
    staleTime: 5 * 60 * 1000,
  });
  const { data: worktree } = useQuery(streamsWorktreeQueryOptions(piSessionId));
  const pickerItems = useMemo(
    () => [...INTERNAL_COMMANDS, ...(skillsData?.items ?? [])],
    [skillsData],
  );
  const isSessionActive = isSessionBusy;

  const interruptMutation = useMutation({
    mutationFn: () => apiClient.interruptPiSession(piSessionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["status"] }),
  });

  // Single endpoint handles both reopen (closed stream) and recover (dead
  // pi-session). Label and icon differ but the server flow is identical.
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

  const { viewportRef, scrollToBottom, isAtBottomRef, engage } = useStickToBottom({
    initialScrollWhen: agentMessages.length > 0,
    initialScrollKey: piSessionId,
  });

  const settleToBottomIfPinned = useCallback(() => {
    if (!isAtBottomRef.current) return;
    const scrollToken = streamingPerf.beginScroll();
    scrollToBottom();
    streamingPerf.endScroll(scrollToken);
  }, [isAtBottomRef, scrollToBottom]);

  // Wire streaming deltas from the streaming store to the Lit web component.
  // We drive scroll explicitly here instead of using MutationObserver /
  // ResizeObserver so streaming updates do not create an observer-driven
  // scroll feedback loop.
  useEffect(() => {
    streamingStore.onStreamingDelta(
      piSessionId,
      (text, thinking, isThinkingStreaming, messageId) => {
        if (messageId != null) {
          messageListRef.current?.updateStreaming(
            {
              role: "assistant",
              content: [
                ...(thinking ? [{ type: "thinking" as const, thinking }] : []),
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
          console.log(
            "[debug][ChatPanel] clearStreaming() — messageId=null, streaming store fired end-of-stream for session=%s",
            piSessionId,
          );
          messageListRef.current?.clearStreaming();
        }
      },
    );

    // Wire imperative commit: message_end pushes converted AgentMessages
    // directly to the Lit component, bypassing the React render cycle.
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
      settleToBottomIfPinned();
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
  }, [piSessionId, settleToBottomIfPinned]);

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

  // Ref for stable handleSubmit closure
  const pendingImagesRef = useRef(pendingImages);
  useEffect(() => {
    pendingImagesRef.current = pendingImages;
  });

  const handleSubmit = useCallback(
    async (text: string) => {
      const images = pendingImagesRef.current.length ? [...pendingImagesRef.current] : undefined;
      if (!text && !images?.length) return;

      setIsSending(true);
      engage();

      try {
        await onSendMessage(text || "(image)", images);
        setPendingImages([]);
      } catch (error) {
        toast.error("Failed to send message");
        console.error("handleSubmit send failed:", error);
      } finally {
        setIsSending(false);
      }
    },
    [engage, onSendMessage],
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex items-center justify-between px-6 py-2 border-b border-border shrink-0 min-h-11 gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <h1 className="text-sm font-semibold text-foreground truncate">
            {streamName ?? "flitterbot"}
          </h1>
          {worktree?.cwd && worktree.cwdAbsolute && (
            <>
              <span className="text-muted-foreground/50 text-xs shrink-0">|</span>
              <span
                className="inline-block text-xs text-muted-foreground truncate max-w-full"
                title={worktree.cwdAbsolute}
              >
                {worktree.cwd}
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isClient && isSessionActive && (
            <Button
              variant="destructive"
              size="sm"
              className="h-6 px-2 text-[11px]"
              disabled={interruptMutation.isPending}
              onClick={() => interruptMutation.mutate()}
            >
              {interruptMutation.isPending ? "Stopping..." : "Stop"}
            </Button>
          )}
          {isClient && !isSessionActive && recoveryKind && streamId && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px]"
              disabled={recoverMutation.isPending}
              onClick={() => recoverMutation.mutate()}
            >
              <RotateCcw className="size-3" />
              {recoverMutation.isPending
                ? recoveryKind === "dead"
                  ? "Recovering..."
                  : "Reopening..."
                : recoveryKind === "dead"
                  ? "Recover"
                  : "Reopen"}
            </Button>
          )}
        </div>
      </div>

      <PanelGroup
        orientation="vertical"
        className="flex-1 min-h-0"
        defaultLayout={chatLayout}
        onLayoutChanged={(layout) => setConfig(CHAT_LAYOUT_KEY, JSON.stringify(layout))}
      >
        {/* Message area */}
        <Panel id="feed" defaultSize="85%" minSize="20%">
          <div
            ref={viewportRef}
            data-scroll-container="main"
            className="h-full overflow-auto px-6 py-4 space-y-3"
          >
            <StreamsMessageList
              ref={messageListRef}
              messages={agentMessages}
              onMessagesRendered={settleToBottomIfPinned}
              onPruneRequested={handlePruneRequested}
            />
          </div>
        </Panel>

        <HorizontalResizeHandle />

        <Panel id="input" defaultSize="15%" minSize="9%">
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
            skills={pickerItems}
            placeholder={streamName ? `Message ${streamName}...` : "Message streams..."}
            fillHeight
            autoFocus
            streamId={streamId}
          />
        </Panel>
      </PanelGroup>
    </div>
  );
}
