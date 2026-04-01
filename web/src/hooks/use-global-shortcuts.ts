import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

/**
 * Global keyboard shortcuts for view navigation.
 * - Option/Alt+S: Surface view (/)
 * - Option/Alt+R: Streams view (/streams)
 */
export function useGlobalShortcuts() {
  const navigate = useNavigate();

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

      switch (event.key) {
        case "s":
          event.preventDefault();
          navigate({ to: "/" });
          break;
        case "r":
          event.preventDefault();
          navigate({ to: "/streams" });
          break;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [navigate]);
}
