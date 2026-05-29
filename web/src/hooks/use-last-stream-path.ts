import { useRouterState } from "@tanstack/react-router";

const lastStreamPath: { current: string | null } = { current: null };

export function useLastStreamPath(): string {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (pathname.startsWith("/streams/")) {
    lastStreamPath.current = pathname;
  }
  return lastStreamPath.current ?? "/streams";
}

export function getLastStreamPath(): string {
  return lastStreamPath.current ?? "/streams";
}
