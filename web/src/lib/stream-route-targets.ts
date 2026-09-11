import type { StatusResponse, StreamSummary } from "@/lib/types";
import { STREAM_SHORTCUT_SLOTS } from "../../../src/shortcuts/catalog.ts";

export function getStreamShortcutTargets(
  defaultPiSessionId: string | undefined,
  streams: readonly StreamSummary[] | undefined,
) {
  const targets: { slot: number; streamId: string | null; path: string }[] = defaultPiSessionId
    ? [{ slot: 1, streamId: null, path: `/streams/${defaultPiSessionId}` }]
    : [];
  for (const stream of streams ?? []) {
    if (targets.length === STREAM_SHORTCUT_SLOTS.length) break;
    if (stream.status === "open" && stream.piSessionId) {
      targets.push({
        slot: targets.length + 1,
        streamId: stream.id,
        path: `/streams/${stream.piSessionId}`,
      });
    }
  }
  return targets;
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
