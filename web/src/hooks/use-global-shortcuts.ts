import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

const DIGIT_CODES = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9"];

/**
 * Global keyboard shortcuts.
 * - Option/Alt+S: Surface view (/)
 * - Option/Alt+R: Last-visited stream (falls back to /streams)
 * - Option/Alt+1-9: Navigate to stream by index
 * - Ctrl+U: Scroll up half page (always, regardless of focus)
 * - Ctrl+D: Scroll down half page (always, regardless of focus)
 */
export function useGlobalShortcuts(streamPaths: string[] = []) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const lastStreamRef = useRef<string | null>(null);

  if (pathname.startsWith("/streams/")) {
    lastStreamRef.current = pathname;
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      // Alt+key: navigation shortcuts
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        switch (event.code) {
          case "KeyS":
            event.preventDefault();
            navigate({ to: "/" });
            return;
          case "KeyR":
            event.preventDefault();
            navigate({ to: lastStreamRef.current ?? "/streams" });
            return;
        }

        const digitIdx = DIGIT_CODES.indexOf(event.code);
        if (digitIdx !== -1 && digitIdx < streamPaths.length) {
          event.preventDefault();
          navigate({ to: streamPaths[digitIdx] });
          return;
        }
      }

      // Ctrl+U/D: scroll message container half-page — always, regardless of focus
      if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
        if (event.key !== "u" && event.key !== "d") return;

        const container = document.querySelector<HTMLElement>("[data-scroll-container]");
        if (!container) return;

        event.preventDefault();
        const amount = container.clientHeight / 2;
        container.scrollBy({
          top: event.key === "d" ? amount : -amount,
          behavior: "smooth",
        });
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [navigate, streamPaths]);
}
