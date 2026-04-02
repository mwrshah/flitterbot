let focusComposer: (() => void) | null = null;

/** Returns true when the active element is an input, textarea, contenteditable, or role=textbox. */
export function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  if (el.getAttribute("role") === "textbox") return true;
  return false;
}

// The app currently exposes one primary composer at a time, so a single
// registered focus target keeps global shortcut ownership centralized.
export function registerComposerFocusTarget(handler: (() => void) | null) {
  focusComposer = handler;
}

export function focusComposerInput() {
  focusComposer?.();
}
