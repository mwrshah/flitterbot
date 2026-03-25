/**
 * React wrapper for pi-web-ui's <assistant-message> to show the
 * currently streaming assistant response.
 *
 * Exposes an imperative API via forwardRef so ChatPanel can push
 * updates directly without triggering React renders.
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ensurePiWebUiReady } from "~/lib/pi-web-ui-init";

export type PiStreamingMessageHandle = {
  update(message: AssistantMessage): void;
  clear(): void;
};

export const PiStreamingMessage = forwardRef<PiStreamingMessageHandle>(
  function PiStreamingMessage(_props, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const elementRef = useRef<HTMLElement | null>(null);
    const [ready, setReady] = useState(false);
    const [error, setError] = useState<unknown>(null);

    useEffect(() => {
      let cancelled = false;

      ensurePiWebUiReady()
        .then(() => {
          if (cancelled) return;
          console.log("[PiStreamingMessage] pi-web-ui ready");
          setReady(true);
        })
        .catch((initError) => {
          if (cancelled) return;
          console.log("[PiStreamingMessage] pi-web-ui initialization failed", initError);
          setError(initError);
        });

      return () => {
        cancelled = true;
      };
    }, []);

    useImperativeHandle(ref, () => ({
      update(message: AssistantMessage) {
        if (!ready || !containerRef.current) return;
        let el = elementRef.current as (HTMLElement & Record<string, unknown>) | null;
        if (!el) {
          el = document.createElement("assistant-message") as HTMLElement & Record<string, unknown>;
          containerRef.current.appendChild(el);
          elementRef.current = el;
        }
        el.message = message;
        el.isStreaming = true;
        el.hideToolCalls = false;
        el.style.display = "block";
      },
      clear() {
        const el = elementRef.current as (HTMLElement & Record<string, unknown>) | null;
        if (!el) return;
        el.style.display = "none";
      },
    }));

    if (error) {
      return (
        <div className="error-text tiny" style={{ padding: "0.75rem 1rem" }}>
          Pi Web UI streaming renderer failed. Check the browser console.
        </div>
      );
    }

    return <div ref={containerRef} />;
  },
);
