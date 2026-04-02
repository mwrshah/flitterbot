import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { focusComposerInput, isInputFocused } from "~/lib/global-shortcuts";
import { getLastStreamPath, useLastStreamPath } from "./use-last-stream-path.ts";

const DIGIT_CODES = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9"];
const HOME_ROW_CODES = ["KeyM", "Comma", "Period", "KeyJ", "KeyK", "KeyL", "KeyU", "KeyI", "KeyO"];

/**
 * Global keyboard shortcuts.
 *
 * Modifier shortcuts (always fire):
 * - Option/Alt+S: Surface view (/)
 * - Option/Alt+R: Last-visited stream (falls back to /streams)
 * - Option/Alt+1-9: Navigate to stream by index
 * - Option/Alt+{m,comma,period,j,k,l,u,i,o}: Navigate to stream 1-9 (home-row)
 * - Ctrl+U / Ctrl+D: Scroll up/down half page
 * - Ctrl+B / Ctrl+F: Scroll up/down full page
 *
 * Bare-key shortcuts (only when no input element is focused):
 * - d / u: Scroll down/up half page
 * - f / b: Scroll down/up full page
 * - gg: Scroll to top (two g presses within 500ms)
 * - Shift+G: Scroll to bottom
 * - i: Focus composer
 * - s: Surface view (/)
 * - r: Last-visited stream (falls back to /streams)
 */
export function useGlobalShortcuts(streamPaths: string[] = []) {
  const navigate = useNavigate();
  useLastStreamPath();

  useEffect(() => {
    let lastGPress = 0;

    function handleKeyDown(event: KeyboardEvent) {
      // Alt+key: navigation shortcuts
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        // Use physical key codes here so Option/Alt combinations still map to
        // the intended home-row stream slots even when event.key varies by layout.
        switch (event.code) {
          case "KeyS":
            event.preventDefault();
            navigate({ to: "/" });
            return;
          case "KeyR":
            event.preventDefault();
            navigate({ to: getLastStreamPath() });
            return;
        }

        const digitIdx = DIGIT_CODES.indexOf(event.code);
        if (digitIdx !== -1 && digitIdx < streamPaths.length) {
          event.preventDefault();
          navigate({ to: streamPaths[digitIdx] });
          return;
        }

        const homeRowIdx = HOME_ROW_CODES.indexOf(event.code);
        if (homeRowIdx !== -1 && homeRowIdx < streamPaths.length) {
          event.preventDefault();
          navigate({ to: streamPaths[homeRowIdx] });
          return;
        }
      }

      // Ctrl+U/D: scroll half-page, Ctrl+B/F: scroll full page — always, regardless of focus
      if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
        const scrollKey = event.key;
        if (scrollKey !== "u" && scrollKey !== "d" && scrollKey !== "b" && scrollKey !== "f") return;

        const container = document.querySelector<HTMLElement>("[data-scroll-container]");
        if (!container) return;

        event.preventDefault();
        const half = container.clientHeight / 2;
        const full = container.clientHeight;
        const isDown = scrollKey === "d" || scrollKey === "f";
        const isFull = scrollKey === "b" || scrollKey === "f";
        container.scrollBy({
          top: isDown ? (isFull ? full : half) : -(isFull ? full : half),
          behavior: "smooth",
        });
        return;
      }

      // Shift+G: scroll to bottom — only when no input is focused
      if (event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && event.key === "G" && !isInputFocused()) {
        const container = document.querySelector<HTMLElement>("[data-scroll-container]");
        if (!container) return;
        event.preventDefault();
        container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
        return;
      }

      // Bare-key shortcuts — only when no modifier is held and no input is focused
      if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !isInputFocused()) {
        // gg: scroll to top (two g presses within 500ms)
        if (event.key === "g") {
          const now = Date.now();
          if (now - lastGPress < 500) {
            lastGPress = 0;
            const container = document.querySelector<HTMLElement>("[data-scroll-container]");
            if (!container) return;
            event.preventDefault();
            container.scrollTo({ top: 0, behavior: "smooth" });
          } else {
            lastGPress = now;
          }
          return;
        }

        // d/u: scroll half page, f/b: scroll full page
        if (event.key === "d" || event.key === "u" || event.key === "f" || event.key === "b") {
          const container = document.querySelector<HTMLElement>("[data-scroll-container]");
          if (!container) return;
          event.preventDefault();
          const half = container.clientHeight / 2;
          const full = container.clientHeight;
          const isDown = event.key === "d" || event.key === "f";
          const isFull = event.key === "f" || event.key === "b";
          container.scrollBy({
            top: isDown ? (isFull ? full : half) : -(isFull ? full : half),
            behavior: "smooth",
          });
          return;
        }

        // i: focus the registered composer target after the input has been blurred.
        if (event.key === "i") {
          event.preventDefault();
          focusComposerInput();
          return;
        }

        // s: surface view
        if (event.key === "s") {
          event.preventDefault();
          navigate({ to: "/" });
          return;
        }

        // r: last-visited stream
        if (event.key === "r") {
          event.preventDefault();
          navigate({ to: getLastStreamPath() });
          return;
        }

      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [navigate, streamPaths]);
}
