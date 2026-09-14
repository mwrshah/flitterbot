import assert from "node:assert/strict";
import test from "node:test";
import {
  type ChatTimelineMessage,
  toUserMessageIndexEntry,
  type UserMessageIndexEntry,
} from "./contracts/index.ts";
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
    { ...message("oldest-user", "user"), content: "old preview ".repeat(100) },
    message("oldest-assistant"),
    message("system", "system"),
    message("newest-user", "user"),
    message("newest-assistant"),
  ];

  const expectedIndex: UserMessageIndexEntry[] = [
    { id: "oldest-user", content: `${items[0]!.content.slice(0, 499)}…` },
    { id: "newest-user", content: "newest-user" },
  ];
  assert.deepEqual(buildUserMessageIndex(items), expectedIndex);

  const newestPage = takePageEndingBeforeCursor(items, 1, null);
  assert.deepEqual(newestPage?.items, [items[4]]);

  const cursor = decodeHistoryCursor(newestPage?.olderPageCursor ?? "");
  assert.ok(cursor);
  const olderPage = takePageEndingBeforeCursor(items, 1, cursor);
  assert.deepEqual(olderPage?.items, [items[3]]);

  assert.deepEqual(buildUserMessageIndex(items), expectedIndex);
});

test("user-message previews preserve IDs and text through the cap boundary", () => {
  for (const length of [0, 499, 500, 501, 1_000_000]) {
    const original = { id: "stable-message-id", content: "a".repeat(length) };
    const entry = toUserMessageIndexEntry(original);
    assert.deepEqual(entry, {
      id: original.id,
      content: length <= 500 ? original.content : `${"a".repeat(499)}…`,
    });
    assert.ok(entry.content.length <= 500);
    assert.equal(original.content.length, length);
  }
});

test("user-message previews preserve Unicode surrogate pairs at the cutoff", () => {
  for (const [content, expected] of [
    ["你好 👋", "你好 👋"],
    ["😀".repeat(250), "😀".repeat(250)],
    ["😀".repeat(251), `${"😀".repeat(249)}…`],
    [`${"a".repeat(497)}😀tail`, `${"a".repeat(497)}😀…`],
    [`${"a".repeat(498)}😀tail`, `${"a".repeat(498)}…`],
    [`${"a".repeat(499)}😀tail`, `${"a".repeat(499)}…`],
  ]) {
    const entry = toUserMessageIndexEntry({ id: "unicode", content: content! });
    assert.equal(entry.content, expected);
    assert.ok(entry.content.length <= 500);
    assert.ok(entry.content.isWellFormed());
  }
});

test("the user-message index includes empty user text and excludes tools", () => {
  assert.deepEqual(
    buildUserMessageIndex([
      { ...message("empty-user", "user"), content: "" },
      {
        id: "tool",
        kind: "tool",
        tool: "read",
        phase: "end",
        toolUseId: "tool-use",
        createdAt: "2026-08-13T00:00:00.000Z",
      },
    ]),
    [{ id: "empty-user", content: "" }],
  );
});
