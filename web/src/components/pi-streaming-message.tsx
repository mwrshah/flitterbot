/**
 * React wrapper for pi-web-ui's <assistant-message> to show the
 * currently streaming assistant response.
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import { useEffect, useRef, useState } from "react";
import { ensurePiWebUiReady } from "~/lib/pi-web-ui-init";

export function PiStreamingMessage({
  message,
  visible,
}: {
  message: AssistantMessage | null;
  visible: boolean;
}) {
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

  useEffect(() => {
    if (!ready || !containerRef.current) return;

    if (!elementRef.current) {
      const el = document.createElement("assistant-message");
      containerRef.current.appendChild(el);
      elementRef.current = el;
      console.log("[PiStreamingMessage] created <assistant-message>");
    }

    const el = elementRef.current as HTMLElement & Record<string, unknown>;
    if (message) {
      el.message = message;
      el.isStreaming = true;
      el.hideToolCalls = false;
      el.style.display = "block";
    } else {
      el.style.display = "none";
    }
  }, [ready, message]);

  if (error) {
    return (
      <div className="error-text tiny" style={{ padding: "0.75rem 1rem" }}>
        Pi Web UI streaming renderer failed. Check the browser console.
      </div>
    );
  }

  if (!visible || !ready) return null;

  return <div ref={containerRef} />;
}
