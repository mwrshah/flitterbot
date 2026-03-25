/**
 * React wrapper for pi-web-ui's <message-list> Lit web component.
 *
 * Imperatively manages the Lit element lifecycle since custom elements
 * need property (not attribute) assignment for complex types like arrays.
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import type { MessageList } from "~/pi-web-ui/chat-components";
import { ensurePiWebUiReady, getPiWebUiInitError } from "~/lib/pi-web-ui-init";

const EMPTY_TOOLS: AgentTool[] = [];

export type PiMessageListHandle = {
  updateStreaming(message: AssistantMessage): void;
  clearStreaming(): void;
};

export const PiMessageList = forwardRef<PiMessageListHandle, {
  messages: AgentMessage[];
}>(function PiMessageList({ messages }, ref) {
  useWhyDidYouRender("PiMessageList", { messages });
  const containerRef = useRef<HTMLDivElement>(null);
  const elementRef = useRef<(MessageList & HTMLElement) | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<unknown>(null);

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
      const el = document.createElement("message-list") as MessageList & HTMLElement;
      el.style.display = "block";
      container.appendChild(el);
      elementRef.current = el;
      console.log("[PiMessageList] created <message-list>");
    }

    const el = elementRef.current;
    el.messages = messages;
    el.tools = EMPTY_TOOLS;
  }, [ready, messages]);

  useImperativeHandle(ref, () => ({
    updateStreaming(message: AssistantMessage) {
      elementRef.current?.updateStreaming(message);
    },
    clearStreaming() {
      elementRef.current?.clearStreaming();
    },
  }));

  useEffect(() => {
    return () => {
      elementRef.current = null;
    };
  }, []);

  if (error) {
    const initDetails = getPiWebUiInitError();
    return (
      <div className="error-text tiny" style={{ padding: "1rem" }}>
        Pi Web UI failed to initialize. Check the browser console.
        {initDetails instanceof Error ? <div>{initDetails.message}</div> : null}
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="muted tiny" style={{ padding: "1rem" }}>
        Loading chat UI…
      </div>
    );
  }

  return <div ref={containerRef} style={{ minHeight: "2rem" }} />;
});
