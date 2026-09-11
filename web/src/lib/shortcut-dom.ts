export function isShortcutInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  let element = target;
  while (element.shadowRoot?.activeElement instanceof HTMLElement) {
    element = element.shadowRoot.activeElement;
  }
  return (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT" ||
    element.isContentEditable ||
    element.getAttribute("role") === "textbox" ||
    element.getAttribute("role") === "searchbox"
  );
}

export function resolveShortcutScrollContainer(root: ParentNode = document): HTMLElement | null {
  return (
    root.querySelector<HTMLElement>('[data-scroll-container="diff"]') ??
    root.querySelector<HTMLElement>('[data-scroll-container="main"]')
  );
}

export function focusComposerInput(root: ParentNode = document): void {
  root.querySelector<HTMLTextAreaElement>("[data-shortcut-composer]")?.focus();
}
