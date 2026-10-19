export function createShortcutScroller() {
  let active: { container: HTMLElement; destination: number; cleanup: () => void } | undefined;

  function reset() {
    active?.cleanup();
    active = undefined;
  }

  function scrollByPage(container: HTMLElement, fraction: number) {
    if (active?.container !== container) reset();
    const height = container.clientHeight;
    const maximum = Math.max(0, container.scrollHeight - height);
    const origin = Math.min(maximum, Math.max(0, active?.destination ?? container.scrollTop));
    const destination = Math.min(maximum, Math.max(0, origin + height * fraction));
    if (active?.destination === destination) return;

    if (!active) {
      const onKeyDown = (event: KeyboardEvent) => {
        if (
          !event.ctrlKey &&
          !event.altKey &&
          !event.metaKey &&
          ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)
        )
          reset();
      };
      const events = ["scrollend", "wheel", "touchstart", "pointerdown"] as const;
      for (const event of events) container.addEventListener(event, reset, { passive: true });
      container.ownerDocument.addEventListener("keydown", onKeyDown);
      active = {
        container,
        destination,
        cleanup: () => {
          for (const event of events) container.removeEventListener(event, reset);
          container.ownerDocument.removeEventListener("keydown", onKeyDown);
        },
      };
    }
    active.destination = destination;
    if (destination === container.scrollTop) reset(); // No-op scrolling does not emit scrollend.
    container.scrollTo({ top: destination, behavior: "smooth" });
  }

  function scrollToEdge(container: HTMLElement, edge: "top" | "bottom") {
    reset();
    container.scrollTo({ top: edge === "top" ? 0 : container.scrollHeight, behavior: "auto" });
  }

  return { scrollByPage, scrollToEdge, reset };
}
