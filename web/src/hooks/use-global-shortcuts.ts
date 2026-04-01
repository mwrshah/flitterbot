import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Global keyboard shortcuts.
 * - Option/Alt+S: Surface view (/)
 * - Option/Alt+R: Streams view (/streams)
 * - Ctrl+U: Scroll up half page
 * - Ctrl+D: Scroll down half page
 */
export function useGlobalShortcuts() {
  const navigate = useNavigate();

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      // Alt+key: navigation shortcuts
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        switch (event.key) {
          case "s":
            event.preventDefault();
            navigate({ to: "/" });
            return;
          case "r":
            event.preventDefault();
            navigate({ to: "/streams" });
            return;
        }
      }

      // Ctrl+key: scroll shortcuts (skip when typing in inputs)
      if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
        if (event.key !== "u" && event.key !== "d") return;
        if (isEditableTarget(event.target)) return;

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
  }, [navigate]);
}
