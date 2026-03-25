/**
 * React wrapper for pi-web-ui's <message-list> Lit web component.
 *
 * Imperatively manages the Lit element lifecycle since custom elements
 * need property (not attribute) assignment for complex types like arrays.
 */

import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import { memo, useEffect, useRef, useState } from "react";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import { ensurePiWebUiReady, getPiWebUiInitError } from "~/lib/pi-web-ui-init";

const EMPTY_TOOLS: AgentTool[] = [];
const EMPTY_PENDING = new Set<string>();

export const PiMessageList = memo(function PiMessageList({
  messages,
  isStreaming = false,
  pendingToolCalls,
}: {
  messages: AgentMessage[];
  isStreaming?: boolean;
  pendingToolCalls?: Set<string>;
}) {
  useWhyDidYouRender("PiMessageList", { messages, isStreaming, pendingToolCalls });
  const containerRef = useRef<HTMLDivElement>(null);
  const elementRef = useRef<HTMLElement | null>(null);
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
      const el = document.createElement("message-list");
      el.style.display = "block";
      container.appendChild(el);
      elementRef.current = el;
      console.log("[PiMessageList] created <message-list>");
    }

    const el = elementRef.current as HTMLElement & Record<string, unknown>;
    el.messages = messages;
    el.tools = EMPTY_TOOLS;
    el.pendingToolCalls = pendingToolCalls ?? EMPTY_PENDING;
    el.isStreaming = isStreaming;
  }, [ready, messages, isStreaming, pendingToolCalls]);

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
