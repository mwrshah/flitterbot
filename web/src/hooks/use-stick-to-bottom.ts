import { useCallback, useEffect, useRef } from "react";

const BOTTOM_THRESHOLD = 50;

/**
 * Stick-to-bottom scroll behavior for scrollable containers.
 *
 * Two modes controlled by `observeDOM`:
 *
 * - `observeDOM: false` (default) — for virtual lists. Tracks pinned state
 *   via scroll events only. The parent calls `scrollToBottom()` when new
 *   content arrives. No MutationObserver / ResizeObserver (those create
 *   feedback loops with virtual lists where scrolling causes DOM mutations).
 *
 * - `observeDOM: true` — for regular (non-virtual) scroll containers.
 *   Uses MutationObserver + ResizeObserver to auto-scroll when children
 *   are added or resized. Safe here because DOM changes = real new content.
 *
 * In both modes:
 * - `scrollToBottom()` — programmatic scroll; does NOT change pinned state.
 * - `engageAndScroll()` — pins AND scrolls (e.g. after sending a message).
 * - `initialScrollWhen` can be used to perform a one-time initial scroll when
 *   the parent knows content is ready.
 */
export function useStickToBottom({
  observeDOM = false,
  initialScrollWhen = false,
  initialScrollKey,
}: {
  observeDOM?: boolean;
  initialScrollWhen?: boolean;
  initialScrollKey?: string;
} = {}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const isAtBottomRef = useRef(true);
  /** Set before programmatic scrolls so the scroll handler ignores them. */
  const isProgrammaticScrollRef = useRef(false);
  const didInitialScrollRef = useRef(false);

  const scrollToBottom = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    isProgrammaticScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
  }, []);

  const engage = useCallback(() => {
    isAtBottomRef.current = true;
  }, []);

  const engageAndScroll = useCallback(() => {
    engage();
    scrollToBottom();
  }, [engage, scrollToBottom]);

  useEffect(() => {
    didInitialScrollRef.current = false;
  }, [initialScrollKey]);

  // Scroll tracking — always active
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const onScroll = () => {
      if (isProgrammaticScrollRef.current) {
        isProgrammaticScrollRef.current = false;
        return;
      }
      isAtBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - BOTTOM_THRESHOLD;
    };
    el.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      el.removeEventListener("scroll", onScroll);
    };
  }, []);

  useEffect(() => {
    if (!initialScrollWhen || didInitialScrollRef.current) return;
    didInitialScrollRef.current = true;

    // Wait until downstream renderers have mounted and painted their initial content.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        engageAndScroll();
      });
    });
  }, [engageAndScroll, initialScrollWhen, initialScrollKey]);

  // DOM observation — only for non-virtual scroll containers
  useEffect(() => {
    if (!observeDOM) return;
    const el = viewportRef.current;
    if (!el) return;

    const ro = new ResizeObserver(() => {
      if (isAtBottomRef.current) {
        isProgrammaticScrollRef.current = true;
        el.scrollTop = el.scrollHeight;
      }
    });
    for (const child of el.children) {
      ro.observe(child);
    }

    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node instanceof Element) {
            ro.observe(node);
          }
        }
      }
      if (isAtBottomRef.current) {
        isProgrammaticScrollRef.current = true;
        el.scrollTop = el.scrollHeight;
      }
    });
    mo.observe(el, { childList: true, subtree: true });

    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [observeDOM]);

  return { viewportRef, isAtBottomRef, scrollToBottom, engage, engageAndScroll };
}
