import { useRouterState } from "@tanstack/react-router";

const lastStreamPath: { current: string | null } = { current: null };

/** Tracks the last-visited /streams/* path. Returns it (or '/streams' as fallback). */
export function useLastStreamPath(): string {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (pathname.startsWith("/streams/")) {
    lastStreamPath.current = pathname;
  }
  return lastStreamPath.current ?? "/streams";
}

/** Read the last stream path without tracking (for use inside effects). */
export function getLastStreamPath(): string {
  return lastStreamPath.current ?? "/streams";
}
