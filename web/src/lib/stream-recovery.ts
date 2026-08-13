import type { StreamSummary } from "@/lib/types";

export type StreamRecoveryKind = "closed" | "dead";

export function getStreamRecoveryKind(
  stream: Pick<StreamSummary, "status" | "piSessionStatus"> | undefined,
): StreamRecoveryKind | undefined {
  if (stream?.status === "closed") return "closed";
  if (stream?.piSessionStatus === "ended" || stream?.piSessionStatus === "crashed") return "dead";
  return undefined;
}
