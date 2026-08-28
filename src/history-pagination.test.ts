import assert from "node:assert/strict";
import test from "node:test";
import type { ChatTimelineMessage } from "./contracts/index.ts";
import {
  buildUserMessageIndex,
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
  assert.equal(page?.olderPageCursor, null);
});

test("the user-message index covers the complete timeline independently of page depth", () => {
  const items = [
    message("oldest-user", "user"),
    message("oldest-assistant"),
    message("system", "system"),
    message("newest-user", "user"),
    message("newest-assistant"),
  ];

  assert.deepEqual(buildUserMessageIndex(items), ["oldest-user", "newest-user"]);

  const newestPage = takePageEndingBeforeCursor(items, 1, null);
  assert.deepEqual(newestPage?.items, [items[4]]);

  const cursor = decodeHistoryCursor(newestPage?.olderPageCursor ?? "");
  assert.ok(cursor);
  const olderPage = takePageEndingBeforeCursor(items, 1, cursor);
  assert.deepEqual(olderPage?.items, [items[3]]);

  assert.equal(buildUserMessageIndex(items).length, 2);
});
