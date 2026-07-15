import type { StatusResponse } from "~/lib/types";

export function getAdjacentStreamPath(
  streamPaths: readonly string[],
  currentPath: string,
  direction: 1 | -1,
): string | undefined {
  if (streamPaths.length === 0) return undefined;

  const currentIndex = streamPaths.indexOf(currentPath);
  if (currentIndex === -1) {
    return direction === 1 ? streamPaths[0] : streamPaths.at(-1);
  }

  return streamPaths[(currentIndex + direction + streamPaths.length) % streamPaths.length];
}

export function isKnownStreamPiSession(status: StatusResponse, piSessionId: string): boolean {
  if (status.piAgent?.default?.piSessionId === piSessionId) return true;
  return (status.streams ?? []).some((stream) => stream.piSessionId === piSessionId);
}

export function getBestStreamPiSessionId(status: StatusResponse): string | undefined {
  return (
    status.piAgent?.default?.piSessionId ??
    status.streams?.find((stream) => stream.status === "open" && stream.piSessionId)?.piSessionId ??
    status.streams?.find((stream) => stream.piSessionId)?.piSessionId
  );
}
