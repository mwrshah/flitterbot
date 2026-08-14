import assert from "node:assert/strict";
import test from "node:test";
import {
  buildConversationFindIndex,
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
    buildConversationFindIndex([row("first", "Alpha alpha"), row("second", "ALPHA")]),
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

test("conversation find indexes tool names and arguments but not results", () => {
  const toolRow: ConversationRow = {
    key: "tool",
    tools: [
      {
        start: {
          id: "tool-start",
          kind: "tool",
          tool: "query_blackboard",
          phase: "start",
          toolUseId: "call-1",
          args: { path: "/repo/file", options: { cwd: "nested-argument" } },
          displayArgs: { path: "~/file", options: { cwd: "nested-argument" } },
          createdAt: "",
        },
        end: {
          id: "tool-end",
          kind: "tool",
          tool: "query_blackboard",
          phase: "end",
          toolUseId: "call-1",
          result: {
            content: [{ value: "content-result" }],
            summary: "sibling-result",
          },
          createdAt: "",
        },
      },
    ],
  };

  const index = buildConversationFindIndex([toolRow]);

  assert.equal(findConversationMatches(index, "query_blackboard").matchCount, 1);
  assert.equal(findConversationMatches(index, "nested-argument").matchCount, 1);
  assert.equal(findConversationMatches(index, "content-result").matchCount, 0);
  assert.equal(findConversationMatches(index, "sibling-result").matchCount, 0);
  assert.equal(findConversationMatches(index, "/repo/file").matchCount, 0);
});
