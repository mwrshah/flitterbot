import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { streamingPerf } from "~/lib/streaming-perf";
import { streamingStore } from "~/lib/streaming-store";
import type { ChatTimelineItem, ChatTimelineMessage, ImageAttachment } from "~/lib/types";
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
  const { config, setConfig } = useUserConfig();
  const chatLayout = parsePanelLayout(config, CHAT_LAYOUT_KEY, CHAT_LAYOUT_DEFAULT);
  const rootApi = getRouteApi("__root__");
  const { apiClient } = rootApi.useRouteContext();
  const queryClient = useQueryClient();
  const messageListRef = useRef<StreamsMessageListHandle>(null);

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

  const { viewportRef, scrollToBottom, isAtBottomRef, engageAndScroll } = useStickToBottom({
    initialScrollWhen: agentMessages.length > 0,
    initialScrollKey: piSessionId,
  });

  // One-shot intent set by handleSubmit: the next render-complete callback
  // unconditionally scrolls to bottom and re-pins, regardless of the current
  // pinned state. Optimistic insert must always reveal the user's own message.
  const forceScrollOnNextRenderRef = useRef(false);

  const handleMessagesRendered = useCallback(() => {
    const scrollToken = streamingPerf.beginScroll();
    if (forceScrollOnNextRenderRef.current) {
      forceScrollOnNextRenderRef.current = false;
      engageAndScroll();
    } else if (isAtBottomRef.current) {
      scrollToBottom();
    }
    streamingPerf.endScroll(scrollToken);
  }, [engageAndScroll, isAtBottomRef, scrollToBottom]);

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

  // Ref for stable handleSubmit closure
  const pendingImagesRef = useRef(pendingImages);
  useEffect(() => {
    pendingImagesRef.current = pendingImages;
  });

  const handleSubmit = useCallback(
    async (text: string) => {
      const images = pendingImagesRef.current.length ? [...pendingImagesRef.current] : undefined;
      if (!text && !images?.length) return;

      // Optimistic insert: append a user-message entry to the agent timeline
      // *before* the WS round-trip, so the feed grows immediately and the
      // scroll-to-bottom driven by the messages-changed React path lands on
      // the real new bottom. The server echoes this id back on user-role
      // `message_end`; the ws-query-bridge swaps the optimistic entry for
      // the canonical one in-place (no duplicate, no ordering flip).
      const clientMessageId = crypto.randomUUID();
      const now = new Date().toISOString();
      const displayText = text || "(image)";
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
      // Force-scroll on the next render-complete callback. Set BEFORE the
      // cache write so the React render it triggers (and the Lit commit that
      // follows) lands with the intent already armed. This always reveals the
      // optimistic message — independent of whether the user was already
      // pinned to the bottom.
      forceScrollOnNextRenderRef.current = true;
      queryClient.setQueryData<ChatTimelineItem[]>(cacheKey, (old) => [...(old ?? []), optimistic]);

      setIsSending(true);

      try {
        await onSendMessage(displayText, { images, clientMessageId });
        setPendingImages([]);
      } catch (error) {
        // Rollback the optimistic entry — the send failed, so the message
        // will never be echoed back. Leaving it in cache would ghost-commit.
        queryClient.setQueryData<ChatTimelineItem[]>(cacheKey, (old) =>
          (old ?? []).filter((item) => item.id !== clientMessageId),
        );
        toast.error("Failed to send message");
        console.error("handleSubmit send failed:", error);
      } finally {
        setIsSending(false);
      }
    },
    [onSendMessage, piSessionId, queryClient],
  );

  // Recover/Reopen is only meaningful when we have a streamId to act on.
  const effectiveRecoveryKind = recoveryKind && streamId ? recoveryKind : undefined;

  return (
    <div className="flex flex-col h-full">
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
              onMessagesRendered={handleMessagesRendered}
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
            fillHeight
            autoFocus
            streamId={streamId}
            isSessionBusy={isSessionBusy}
            onInterrupt={() => interruptMutation.mutate()}
            isInterruptPending={interruptMutation.isPending}
            recoveryKind={effectiveRecoveryKind}
            onRecover={() => recoverMutation.mutate()}
            isRecoverPending={recoverMutation.isPending}
          />
        </Panel>
      </PanelGroup>
    </div>
  );
}
