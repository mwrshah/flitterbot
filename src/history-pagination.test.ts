import assert from "node:assert/strict";
import test from "node:test";
import type { ChatTimelineMessage } from "./contracts/index.ts";
import {
  decodeHistoryCursor,
  parseVisibleRowLimit,
  takePageEndingBeforeCursor,
} from "./streams/history.ts";

function message(id: string, role: ChatTimelineMessage["role"] = "assistant"): ChatTimelineMessage {
  return {
    id,
    kind: "message",
    role,
    content: id,
    createdAt: "2026-08-13T00:00:00.000Z",
  };
}

test("the all history limit returns the complete timeline as one terminal page", () => {
  const items = [message("oldest"), message("middle"), message("newest")];
  const page = takePageEndingBeforeCursor(items, parseVisibleRowLimit("all"), null);

  assert.deepEqual(page?.items, items);
  assert.equal(page?.totalUserMessages, 0);
  assert.equal(page?.olderPageCursor, null);
});

test("every page reports the complete timeline user-message total", () => {
  const items = [
    message("oldest-user", "user"),
    message("oldest-assistant"),
    message("newest-user", "user"),
    message("newest-assistant"),
  ];
  const newestPage = takePageEndingBeforeCursor(items, 1, null);

  assert.deepEqual(newestPage?.items, [items[3]]);
  assert.equal(newestPage?.totalUserMessages, 2);

  const cursor = decodeHistoryCursor(newestPage?.olderPageCursor ?? "");
  assert.ok(cursor);
  const olderPage = takePageEndingBeforeCursor(items, 1, cursor);

  assert.deepEqual(olderPage?.items, [items[2]]);
  assert.equal(olderPage?.totalUserMessages, 2);
});
