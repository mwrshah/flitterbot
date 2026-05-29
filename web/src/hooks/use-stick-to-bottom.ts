import { useCallback, useEffect, useRef } from "react";

const BOTTOM_THRESHOLD = 50;

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

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        engageAndScroll();
      });
    });
  }, [engageAndScroll, initialScrollWhen, initialScrollKey]);

  return { viewportRef, isAtBottomRef, scrollToBottom, engageAndScroll };
}
