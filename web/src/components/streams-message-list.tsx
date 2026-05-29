import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { memo, type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import type { ActiveToolState } from "~/lib/active-tool-store";
import { ensurePiWebUiReady, getPiWebUiInitError } from "~/lib/pi-web-ui-init";
import { streamingPerf } from "~/lib/streaming-perf";
import type { MessageList } from "~/pi-web-ui/chat-components";

const EMPTY_TOOLS: AgentTool[] = [];
const EMPTY_PENDING = new Set<string>();
type MessageListElement = HTMLElement & MessageList & { updateComplete: Promise<unknown> };

export type StreamsMessageListHandle = {
  updateStreaming(message: AssistantMessage, isThinkingStreaming: boolean): void;
  clearStreaming(): void;
  commitStreaming(messages: AgentMessage[]): void;
  commitToolResult(message: AgentMessage): boolean;
  setActiveTools(states: ActiveToolState[]): void;
  applyActiveToolState(state: ActiveToolState): void;
  clearActiveTools(): void;
};

type StreamsMessageListProps = {
  messages: AgentMessage[];
  onMessagesRendered?: () => void;
  onPruneRequested?: (entryId: string) => void;
  isSessionBusy?: boolean;
  ref?: Ref<StreamsMessageListHandle>;
};

export const StreamsMessageList = memo(function StreamsMessageList({
  messages,
  onMessagesRendered,
  onPruneRequested,
  isSessionBusy = false,
  ref,
}: StreamsMessageListProps) {
  useWhyDidYouRender("StreamsMessageList", { messages, onMessagesRendered, isSessionBusy });
  const containerRef = useRef<HTMLDivElement>(null);
  const elementRef = useRef<MessageListElement | null>(null);
  const pendingActiveToolsRef = useRef<Map<string, ActiveToolState>>(new Map());
  const clearActiveToolsQueuedRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const notifyMessagesRendered = (renderComplete?: Promise<unknown>) => {
    const el = elementRef.current;
    if (!el) return;
    void (renderComplete ?? el.updateComplete).then(() => {
      if (elementRef.current !== el) return;
      flushActiveTools();
      requestAnimationFrame(() => {
        onMessagesRendered?.();
      });
    });
  };

  const flushActiveTools = () => {
    const el = elementRef.current;
    if (!el) return;
    if (clearActiveToolsQueuedRef.current) {
      el.clearActiveTools();
      clearActiveToolsQueuedRef.current = false;
    }
    if (pendingActiveToolsRef.current.size > 0) {
      el.setActiveTools(Array.from(pendingActiveToolsRef.current.values()));
    }
  };

  useEffect(() => {
    let cancelled = false;

    ensurePiWebUiReady()
      .then(() => {
        if (cancelled) return;
        setReady(true);
      })
      .catch((initError) => {
        if (cancelled) return;
        setError(initError);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const container = containerRef.current;
    if (!container) return;

    if (!elementRef.current) {
      const el = document.createElement("message-list") as MessageListElement;
      el.style.display = "block";
      container.appendChild(el);
      elementRef.current = el;
    }

    const el = elementRef.current as MessageListElement & Record<string, unknown>;
    flushActiveTools();

    const renderToken = streamingPerf.beginCommittedLitRender();
    el.messages = messages;
    el.tools = EMPTY_TOOLS;
    el.pendingToolCalls = EMPTY_PENDING;
    el.isSessionBusy = isSessionBusy;
    void el.updateComplete.then(() => {
      streamingPerf.endCommittedLitRender(renderToken);
      notifyMessagesRendered();
    });
  }, [ready, messages, onMessagesRendered, isSessionBusy]);

  useEffect(() => {
    return () => {
      elementRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const container = containerRef.current;
    if (!container) return;
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ entryId?: string }>).detail;
      const entryId = detail?.entryId;
      if (!entryId) return;
      onPruneRequested?.(entryId);
    };
    container.addEventListener("prune-message", handler);
    return () => {
      container.removeEventListener("prune-message", handler);
    };
  }, [ready, onPruneRequested]);

  useImperativeHandle(ref, () => ({
    updateStreaming(message: AssistantMessage, isThinkingStreaming: boolean) {
      const renderComplete = elementRef.current?.updateStreaming(message, isThinkingStreaming);
      notifyMessagesRendered(renderComplete);
    },
    clearStreaming() {
      elementRef.current?.clearStreaming();
    },
    commitStreaming(messages: AgentMessage[]) {
      elementRef.current?.commitStreaming(messages);
      notifyMessagesRendered();
    },
    commitToolResult(message: AgentMessage) {
      const committed = elementRef.current?.commitToolResult(message) ?? false;
      if (committed) notifyMessagesRendered();
      return committed;
    },
    setActiveTools(states: ActiveToolState[]) {
      pendingActiveToolsRef.current = new Map(states.map((state) => [state.toolUseId, state]));
      clearActiveToolsQueuedRef.current = false;
      elementRef.current?.setActiveTools(states);
    },
    applyActiveToolState(state: ActiveToolState) {
      pendingActiveToolsRef.current.set(state.toolUseId, state);
      clearActiveToolsQueuedRef.current = false;
      elementRef.current?.applyActiveToolState(state);
    },
    clearActiveTools() {
      pendingActiveToolsRef.current.clear();
      clearActiveToolsQueuedRef.current = true;
      if (elementRef.current) {
        elementRef.current.clearActiveTools();
        clearActiveToolsQueuedRef.current = false;
      }
    },
  }));

  if (error) {
    const initDetails = getPiWebUiInitError();
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-4">
        <p className="text-xs font-medium text-destructive">
          Streams Web UI failed to initialize. Check the browser console.
        </p>
        {initDetails instanceof Error ? (
          <p className="text-xs text-destructive/70">{initDetails.message}</p>
        ) : null}
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <p className="text-xs text-muted-foreground">Loading chat UI…</p>
      </div>
    );
  }

  return <div ref={containerRef} style={{ minHeight: "2rem" }} />;
}, areStreamsMessageListPropsEqual);

function areStreamsMessageListPropsEqual(
  prev: StreamsMessageListProps,
  next: StreamsMessageListProps,
) {
  return prev.messages === next.messages && prev.isSessionBusy === next.isSessionBusy;
}
