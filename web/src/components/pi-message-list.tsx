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
import { ensurePiWebUiReady, getPiWebUiInitError } from "~/lib/pi-web-ui-init";
import type { MessageList } from "~/pi-web-ui/chat-components";

const EMPTY_TOOLS: AgentTool[] = [];
const EMPTY_PENDING = new Set<string>();

export type PiMessageListHandle = {
  updateStreaming(message: AssistantMessage, isThinkingStreaming: boolean): void;
  clearStreaming(): void;
};

export const PiMessageList = memo(
  forwardRef<PiMessageListHandle, { messages: AgentMessage[] }>(function PiMessageList(
    { messages },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const elementRef = useRef<(HTMLElement & MessageList) | null>(null);
    const [ready, setReady] = useState(false);
    const [error, setError] = useState<unknown>(null);

    // Debug: trace every time the messages prop reference changes (indicates timeline grew)
    useEffect(() => {
      console.log("[debug][PiMessageList] messages.length=%d", messages.length);
    }, [messages]);

    useEffect(() => {
      let cancelled = false;

      ensurePiWebUiReady()
        .then(() => {
          if (cancelled) return;
          console.log("[PiMessageList] pi-web-ui ready");
          setReady(true);
        })
        .catch((initError) => {
          if (cancelled) return;
          console.log("[PiMessageList] pi-web-ui initialization failed", initError);
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
        const el = document.createElement("message-list") as HTMLElement & MessageList;
        el.style.display = "block";
        container.appendChild(el);
        elementRef.current = el;
        console.log("[PiMessageList] created <message-list>");
      }

      const el = elementRef.current as HTMLElement & MessageList & Record<string, unknown>;
      el.messages = messages;
      el.tools = EMPTY_TOOLS;
      el.pendingToolCalls = EMPTY_PENDING;
    }, [ready, messages]);

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
    }));

    if (error) {
      const initDetails = getPiWebUiInitError();
      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-4">
          <p className="text-xs font-medium text-destructive">
            Pi Web UI failed to initialize. Check the browser console.
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
  // Custom equality: skip re-render if messages array is the same reference
  // (useAgentMessages returns a stable reference via fingerprinting)
  (prev, next) => prev.messages === next.messages,
);
