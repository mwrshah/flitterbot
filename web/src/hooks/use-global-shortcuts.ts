import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";
import { toast } from "sonner";
import {
  focusComposerInput,
  getActiveScrollContainerSelector,
  getStreamSlotShortcutActionId,
  handleRegisteredShortcutKeyDown,
  registerShortcutHandlers,
  setActiveScrollContainer,
  SHORTCUT_ACTIONS,
  setShortcutBindingOverrides,
} from "~/lib/global-shortcuts";
import type { ShortcutBindingsConfig } from "~/lib/types";
import { getLastStreamPath, useLastStreamPath } from "./use-last-stream-path.ts";

type UseGlobalShortcutsOptions = {
  streamPaths?: string[];
  shortcutBindings?: ShortcutBindingsConfig;
};

/**
 * Global keyboard shortcuts.
 *
 * Supports:
 * - modifier combos like Alt+R / Ctrl+D
 * - multi-key sequences like g g and c t
 *
 * Bindings are resolved by action id so user overrides can come from config
 * without changing the matching logic.
 */
export function useGlobalShortcuts({
  streamPaths = [],
  shortcutBindings,
}: UseGlobalShortcutsOptions = {}) {
  const navigate = useNavigate();
  useLastStreamPath();

  const navigateHome = useEffectEvent(() => {
    navigate({ to: "/" });
    return true;
  });

  const navigateLastStream = useEffectEvent(() => {
    navigate({ to: getLastStreamPath() });
    return true;
  });

  const navigateStreamSlot = useEffectEvent((slot: number) => {
    const to = streamPaths[slot - 1];
    if (!to) return false;
    navigate({ to });
    return true;
  });

  const scrollByPage = useEffectEvent((mode: "half-up" | "half-down" | "full-up" | "full-down") => {
    const container = document.querySelector<HTMLElement>(getActiveScrollContainerSelector());
    if (!container) return false;

    const half = container.clientHeight * 0.7;
    const full = container.clientHeight;
    const delta =
      mode === "half-down"
        ? half
        : mode === "half-up"
          ? -half
          : mode === "full-down"
            ? full
            : -full;

    container.scrollBy({
      top: delta,
      behavior: "smooth",
    });
    return true;
  });

  const scrollToTop = useEffectEvent(() => {
    const container = document.querySelector<HTMLElement>(getActiveScrollContainerSelector());
    if (!container) return false;
    container.scrollTo({ top: 0, behavior: "auto" });
    return true;
  });

  const scrollToBottom = useEffectEvent(() => {
    const container = document.querySelector<HTMLElement>(getActiveScrollContainerSelector());
    if (!container) return false;
    container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
    return true;
  });

  const focusComposer = useEffectEvent(() => {
    setActiveScrollContainer("main");
    focusComposerInput();
    return true;
  });

  const copyTmuxFallback = useEffectEvent(() => {
    toast.error("No tmux session available");
    return true;
  });

  const copyWorktreeFallback = useEffectEvent(() => {
    toast.error("No worktree path available");
    return true;
  });

  useEffect(() => {
    setShortcutBindingOverrides(shortcutBindings);
    return () => setShortcutBindingOverrides(undefined);
  }, [shortcutBindings]);

  useEffect(() => {
    const cleanupHandlers = registerShortcutHandlers([
      { actionId: SHORTCUT_ACTIONS.navSurface, handler: () => navigateHome() },
      { actionId: SHORTCUT_ACTIONS.navLastStream, handler: () => navigateLastStream() },
      { actionId: SHORTCUT_ACTIONS.scrollHalfPageDown, handler: () => scrollByPage("half-down") },
      { actionId: SHORTCUT_ACTIONS.scrollHalfPageUp, handler: () => scrollByPage("half-up") },
      { actionId: SHORTCUT_ACTIONS.scrollFullPageDown, handler: () => scrollByPage("full-down") },
      { actionId: SHORTCUT_ACTIONS.scrollFullPageUp, handler: () => scrollByPage("full-up") },
      { actionId: SHORTCUT_ACTIONS.scrollTop, handler: () => scrollToTop() },
      { actionId: SHORTCUT_ACTIONS.scrollBottom, handler: () => scrollToBottom() },
      { actionId: SHORTCUT_ACTIONS.composerFocus, handler: () => focusComposer() },
      { actionId: SHORTCUT_ACTIONS.streamCopyTmuxAttach, handler: () => copyTmuxFallback() },
      { actionId: SHORTCUT_ACTIONS.streamCopyWorktreePath, handler: () => copyWorktreeFallback() },
      ...Array.from({ length: 9 }, (_, index) => ({
        actionId: getStreamSlotShortcutActionId(index + 1),
        handler: () => navigateStreamSlot(index + 1),
      })),
    ]);

    function handleKeyDown(event: KeyboardEvent) {
      handleRegisteredShortcutKeyDown(event);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      cleanupHandlers();
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);
}
