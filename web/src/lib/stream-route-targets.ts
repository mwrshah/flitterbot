import type { StatusResponse } from "~/lib/types";

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
