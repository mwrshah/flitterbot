import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { resolveShortcutScrollContainer } from "@/lib/shortcut-dom";
import { type ShortcutActionHandlers, useShortcuts } from "@/lib/shortcuts";
import {
  getStreamSlotShortcutActionId,
  STREAM_SHORTCUT_SLOTS,
} from "../../../src/shortcuts/catalog.ts";
import { useCreateSwimlane } from "./use-create-swimlane";
import { getLastStreamPath, useLastStreamPath } from "./use-last-stream-path.ts";

type ScrollMode = "half-up" | "half-down" | "full-up" | "full-down" | "small-up" | "small-down";

const SCROLL_FRACTIONS: Record<ScrollMode, number> = {
  "half-down": 0.6,
  "half-up": -0.6,
  "full-down": 0.9,
  "full-up": -0.9,
  "small-down": 0.2,
  "small-up": -0.2,
};

function hasScrollContainer() {
  return Boolean(resolveShortcutScrollContainer());
}

function scrollByPage(mode: ScrollMode) {
  const container = resolveShortcutScrollContainer();
  if (!container) return;
  container.scrollBy({ top: container.clientHeight * SCROLL_FRACTIONS[mode], behavior: "smooth" });
}

function scrollToEdge(edge: "top" | "bottom") {
  const container = resolveShortcutScrollContainer();
  if (!container) return;
  container.scrollTo({ top: edge === "top" ? 0 : container.scrollHeight, behavior: "auto" });
}

export function useGlobalShortcuts({ streamPaths = [] }: { streamPaths?: string[] } = {}) {
  const navigate = useNavigate();
  const createSwimlaneMutation = useCreateSwimlane();
  useLastStreamPath();

  const handlers: ShortcutActionHandlers = {
    "nav.surface": { run: () => navigate({ to: "/" }) },
    "nav.last-stream": { run: () => navigate({ to: getLastStreamPath() }) },
    "swimlane.create": {
      enabled: !createSwimlaneMutation.isPending,
      run: () => createSwimlaneMutation.mutate(),
    },
    "scroll.half-page-down": {
      enabled: hasScrollContainer,
      run: () => scrollByPage("half-down"),
    },
    "scroll.half-page-up": {
      enabled: hasScrollContainer,
      run: () => scrollByPage("half-up"),
    },
    "scroll.full-page-down": {
      enabled: hasScrollContainer,
      run: () => scrollByPage("full-down"),
    },
    "scroll.full-page-up": {
      enabled: hasScrollContainer,
      run: () => scrollByPage("full-up"),
    },
    "scroll.small-down": {
      enabled: hasScrollContainer,
      run: () => scrollByPage("small-down"),
    },
    "scroll.small-up": {
      enabled: hasScrollContainer,
      run: () => scrollByPage("small-up"),
    },
    "scroll.top": {
      enabled: hasScrollContainer,
      run: () => scrollToEdge("top"),
    },
    "scroll.bottom": {
      enabled: hasScrollContainer,
      run: () => scrollToEdge("bottom"),
    },
    "stream.copy-worktree-path": {
      run: () => toast.error("No worktree path available"),
    },
    "stream.copy-repo-path": { run: () => toast.error("No repo path available") },
    "stream.copy-branch": { run: () => toast.error("No branch available") },
    "stream.copy-target-branch": {
      run: () => toast.error("No target branch available"),
    },
    "stream.edit-current-directory": {
      run: () => toast.error("No current directory available"),
    },
  };

  for (const slot of STREAM_SHORTCUT_SLOTS) {
    handlers[getStreamSlotShortcutActionId(slot)] = {
      enabled: Boolean(streamPaths[slot - 1]),
      run: () => {
        const to = streamPaths[slot - 1];
        if (to) navigate({ to });
      },
    };
  }

  useShortcuts("app", handlers);
}
