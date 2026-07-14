import type { ChatTimelineItem } from "./types";

export function latestMeasuredContextTokens(timeline: ChatTimelineItem[]): number | null {
  let latestCompactionAt = Number.NEGATIVE_INFINITY;
  for (const item of timeline) {
    if (item.kind === "message" && item.compaction) {
      latestCompactionAt = Math.max(latestCompactionAt, Date.parse(item.createdAt));
    }
  }

  for (let index = timeline.length - 1; index >= 0; index--) {
    const item = timeline[index];
    if (
      item?.kind === "message" &&
      item.role === "assistant" &&
      item.usage &&
      Date.parse(item.createdAt) > latestCompactionAt
    ) {
      return item.usage.totalTokens;
    }
  }
  return null;
}
