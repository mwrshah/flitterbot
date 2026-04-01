import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

const DIGIT_CODES = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9"];

/**
 * Global keyboard shortcuts for view navigation.
 * - Option/Alt+S: Surface view (/)
 * - Option/Alt+R: Last-visited stream (falls back to /streams)
 * - Option/Alt+1-9: Navigate to stream by index
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
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

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
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [navigate, streamPaths]);
}
