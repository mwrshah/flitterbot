import assert from "node:assert/strict";
import test from "node:test";
import { latestMeasuredContextTokens } from "./context-usage.ts";
import type { ChatTimelineItem, ChatTimelineMessage } from "./types";

function message(
  id: string,
  role: ChatTimelineMessage["role"],
  createdAt: string,
  totalTokens?: number,
  compaction = false,
): ChatTimelineMessage {
  return {
    id,
    kind: "message",
    role,
    content: id,
    createdAt,
    ...(totalTokens === undefined
      ? {}
      : {
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens },
        }),
    ...(compaction ? { compaction: true } : {}),
  };
}

test("returns no measured usage until an assistant responds after compaction", () => {
  const timeline: ChatTimelineItem[] = [
    message("old assistant", "assistant", "2026-07-14T00:00:00.000Z", 142_000),
    message("compaction", "user", "2026-07-14T00:01:00.000Z", undefined, true),
    message("retained assistant", "assistant", "2026-07-14T00:00:30.000Z", 142_000),
  ];

  assert.equal(latestMeasuredContextTokens(timeline), null);

  timeline.push(message("new assistant", "assistant", "2026-07-14T00:02:00.000Z", 34_000));
  assert.equal(latestMeasuredContextTokens(timeline), 34_000);
});
