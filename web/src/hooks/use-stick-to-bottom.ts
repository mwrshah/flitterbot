import { useCallback, useEffect, useRef } from "react";

const BOTTOM_THRESHOLD = 50;

/**
 * Stick-to-bottom scroll behavior for scrollable containers.
 *
 * - The scroll handler tracks pinned state from scroll position. User
 *   scrolling up past the threshold unpins; scrolling back into the
 *   threshold re-pins.
 * - The parent calls `scrollToBottom()` when new content lands and pinned
 *   behavior is desired (e.g. streaming deltas), or `engageAndScroll()` to
 *   force pin + scroll regardless of current state (e.g. submit).
 * - `initialScrollWhen` performs a one-time initial scroll once the parent
 *   signals content is ready; `initialScrollKey` rearms it on identity change.
 *
 * Note: programmatic scrolls don't need special handling — after
 * `scrollTop = scrollHeight`, the scroll event re-evaluates the threshold
 * and lands on `isAtBottomRef = true` naturally.
 */
export function useStickToBottom({
  initialScrollWhen = false,
  initialScrollKey,
}: {
  initialScrollWhen?: boolean;
  initialScrollKey?: string;
} = {}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const isAtBottomRef = useRef(true);
  const didInitialScrollRef = useRef(false);

  const scrollToBottom = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  const engageAndScroll = useCallback(() => {
    isAtBottomRef.current = true;
    scrollToBottom();
  }, [scrollToBottom]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onScroll = () => {
      isAtBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - BOTTOM_THRESHOLD;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
    };
  }, []);

  useEffect(() => {
    didInitialScrollRef.current = false;
  }, [initialScrollKey]);

  useEffect(() => {
    if (!initialScrollWhen || didInitialScrollRef.current) return;
    didInitialScrollRef.current = true;

    // Wait until downstream renderers have mounted and painted their initial
    // content. Two rAFs ensure scrollHeight reflects the final DOM.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        engageAndScroll();
      });
    });
  }, [engageAndScroll, initialScrollWhen, initialScrollKey]);

  return { viewportRef, isAtBottomRef, scrollToBottom, engageAndScroll };
}
