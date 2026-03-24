import { useCallback, useEffect, useRef } from "react";

const BOTTOM_THRESHOLD = 50;

/**
 * Stick-to-bottom scroll behavior for chat containers.
 *
 * - Auto-scrolls to bottom when new content appears (new children or size changes)
 * - Stops auto-scrolling when the user scrolls up past a threshold
 * - Re-engages auto-scroll when the user scrolls back to the bottom
 *
 * Returns a ref to attach to the scrollable viewport and a function to
 * programmatically force scroll-to-bottom (e.g. after sending a message).
 */
export function useStickToBottom() {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const isAtBottomRef = useRef(true);
  const roRef = useRef<ResizeObserver | null>(null);
  const moRef = useRef<MutationObserver | null>(null);

  const scrollToBottom = useCallback(() => {
    const el = viewportRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const engageAndScroll = useCallback(() => {
    isAtBottomRef.current = true;
    scrollToBottom();
  }, [scrollToBottom]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    // --- Scroll listener: track whether user is at bottom ---
    const onScroll = () => {
      isAtBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - BOTTOM_THRESHOLD;
    };
    el.addEventListener("scroll", onScroll, { passive: true });

    // --- ResizeObserver: when any child resizes, scroll if anchored ---
    const ro = new ResizeObserver(() => {
      if (isAtBottomRef.current) {
        el.scrollTop = el.scrollHeight;
      }
    });
    roRef.current = ro;

    // Observe all current children
    for (const child of el.children) {
      ro.observe(child);
    }

    // --- MutationObserver: observe new children added to viewport ---
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node instanceof Element) {
            ro.observe(node);
          }
        }
      }
      // Scroll after new content is added
      if (isAtBottomRef.current) {
        el.scrollTop = el.scrollHeight;
      }
    });
    moRef.current = mo;
    mo.observe(el, { childList: true, subtree: true });

    // Initial scroll
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });

    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  return { viewportRef, isAtBottomRef, scrollToBottom, engageAndScroll };
}
