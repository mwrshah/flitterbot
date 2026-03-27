/**
 * Ref-based memoization keyed by a fingerprint string.
 *
 * Unlike useMemo (which uses reference equality on deps), this only
 * recomputes `fn` when the fingerprint changes — useful when an input
 * array is structurally the same but has a new reference on every
 * render (e.g. TanStack Query data after setQueryData).
 */

import { useRef } from "react";

export function useStableMemo<T>(fingerprint: string, fn: () => T): T {
  const prevFpRef = useRef("");
  const prevResultRef = useRef<T>(undefined as T);

  if (fingerprint !== prevFpRef.current) {
    prevFpRef.current = fingerprint;
    prevResultRef.current = fn();
  }

  return prevResultRef.current;
}
