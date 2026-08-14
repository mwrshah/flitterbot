import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationFindRowAt,
  findConversationMatches,
  mergeFindTimeline,
  moveConversationFindSelection,
} from "../src/lib/conversation-find.ts";
import type { ConversationRow } from "../src/lib/conversation-rows.ts";

function row(id: string, content: string): ConversationRow {
  return {
    key: id,
    message: {
      id,
      kind: "message",
      role: "assistant",
      content,
      createdAt: "",
    },
    tools: [],
  };
}

test("conversation find counts, navigates, and merges route history", () => {
  const results = findConversationMatches(
    [row("first", "Alpha alpha"), row("second", "ALPHA")],
    "alpha",
  );
  assert.equal(results.matchCount, 3);
  assert.equal(conversationFindRowAt(results, 2), 1);
  assert.equal(moveConversationFindSelection(2, 3, 1), 0);

  assert.deepEqual(
    mergeFindTimeline(
      [row("old", "old").message!, row("same", "stale").message!],
      [row("same", "current").message!, row("new", "new").message!],
    ).map((item) => item.content),
    ["old", "current", "new"],
  );
});
