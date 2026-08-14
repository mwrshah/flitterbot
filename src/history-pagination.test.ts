import assert from "node:assert/strict";
import test from "node:test";
import type { ChatTimelineMessage } from "./contracts/index.ts";
import { parseVisibleRowLimit, takePageEndingBeforeCursor } from "./streams/history.ts";

function message(id: string): ChatTimelineMessage {
  return {
    id,
    kind: "message",
    role: "assistant",
    content: id,
    createdAt: "2026-08-13T00:00:00.000Z",
  };
}

test("the all history limit returns the complete timeline as one terminal page", () => {
  const items = [message("oldest"), message("middle"), message("newest")];
  const page = takePageEndingBeforeCursor(items, parseVisibleRowLimit("all"), null);

  assert.deepEqual(page?.items, items);
  assert.equal(page?.olderPageCursor, null);
});
