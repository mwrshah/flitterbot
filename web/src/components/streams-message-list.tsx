/**
 * React wrapper for pi-web-ui's <message-list> Lit web component.
 *
 * Imperatively manages the Lit element lifecycle since custom elements
 * need property (not attribute) assignment for complex types like arrays.
 *
 * Exposes updateStreaming / clearStreaming via forwardRef so ChatPanel can
 * push streaming deltas directly to the Lit component without React renders.
 */

import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { forwardRef, memo, useEffect, useImperativeHandle, useRef, useState } from "react";
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

export const StreamsMessageList = memo(
  forwardRef<
    StreamsMessageListHandle,
    { messages: AgentMessage[]; onMessagesRendered?: () => void }
  >(function StreamsMessageList({ messages, onMessagesRendered }, ref) {
    useWhyDidYouRender("StreamsMessageList", { messages, onMessagesRendered });
    const containerRef = useRef<HTMLDivElement>(null);
    const elementRef = useRef<MessageListElement | null>(null);
    const pendingActiveToolsRef = useRef<Map<string, ActiveToolState>>(new Map());
    const clearActiveToolsQueuedRef = useRef(false);
    /** Set to true after commitStreaming — the next React-driven messages update
     *  skips perf tracking since the Lit component already has the data. */
    const committedRef = useRef(false);
    const [ready, setReady] = useState(false);
    const [error, setError] = useState<unknown>(null);

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

      // If Lit already committed these messages imperatively (message_end path),
      // sync the property for internal consistency (e.g. getTurnCopyText) but
      // skip perf tracking and scroll — the Lit component's shouldUpdate will
      // suppress the redundant render.
      if (committedRef.current) {
        committedRef.current = false;
        console.log(
          "[debug][StreamsMessageList] React catch-up: skipping perf tracking (Lit already committed)",
        );
        el.messages = messages;
        el.tools = EMPTY_TOOLS;
        el.pendingToolCalls = EMPTY_PENDING;
        flushActiveTools();
        return;
      }

      const renderToken = streamingPerf.beginCommittedLitRender();
      el.messages = messages;
      el.tools = EMPTY_TOOLS;
      el.pendingToolCalls = EMPTY_PENDING;
      void el.updateComplete.then(() => {
        flushActiveTools();
        streamingPerf.endCommittedLitRender(renderToken);
        // Defer scroll until after the browser runs layout — updateComplete
        // resolves when the parent Lit element finishes, but child components
        // may still be rendering.  rAF ensures scrollHeight reflects final DOM.
        requestAnimationFrame(() => {
          onMessagesRendered?.();
        });
      });
    }, [ready, messages, onMessagesRendered]);

    useEffect(() => {
      return () => {
        elementRef.current = null;
      };
    }, []);

    useImperativeHandle(ref, () => ({
      updateStreaming(message: AssistantMessage, isThinkingStreaming: boolean) {
        elementRef.current?.updateStreaming(message, isThinkingStreaming);
      },
      clearStreaming() {
        elementRef.current?.clearStreaming();
      },
      commitStreaming(messages: AgentMessage[]) {
        elementRef.current?.commitStreaming(messages);
        committedRef.current = true;
      },
      commitToolResult(message: AgentMessage) {
        const committed = elementRef.current?.commitToolResult(message) ?? false;
        if (committed) {
          committedRef.current = true;
        }
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
  }),
  // Custom equality: skip re-render if messages array is the same reference.
  (prev, next) => prev.messages === next.messages,
);
