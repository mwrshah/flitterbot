import assert from "node:assert/strict";
import test from "node:test";
import type { ChatTimelineItem, ChatTimelineMessage, ChatTimelineTool } from "../src/lib/types.ts";
import {
  buildConversationContentParts,
  buildConversationRows,
} from "../src/lib/conversation-rows.ts";

const createdAt = "2026-08-05T00:00:00.000Z";

function message(
  id: string,
  role: ChatTimelineMessage["role"],
  content: string,
): ChatTimelineMessage {
  return { id, kind: "message", role, content, createdAt };
}

function tool(
  id: string,
  phase: ChatTimelineTool["phase"],
  toolUseId: string,
): ChatTimelineTool {
  return { id, kind: "tool", tool: "bash", phase, toolUseId, createdAt };
}

test("groups canonical tools with assistant rows and pairs committed results", () => {
  const items: ChatTimelineItem[] = [
    message("u1", "user", "run it"),
    message("a1", "assistant", "working"),
    { ...tool("t1-start", "start", "call-1"), args: { command: "pwd" } },
    { ...tool("t1-end", "end", "call-1"), result: "ok" },
  ];

  const rows = buildConversationRows(items);

  assert.equal(rows.length, 2);
  assert.equal(rows[1]?.key, "row:a1");
  assert.equal(rows[1]?.tools[0]?.start.id, "t1-start");
  assert.equal(rows[1]?.tools[0]?.end?.id, "t1-end");
  assert.equal(rows[1]?.copyText, "working");
});

test("preserves updates and orphan tools without rendering system or divider rows", () => {
  const items: ChatTimelineItem[] = [
    message("system", "system", "hidden"),
    tool("orphan-update", "update", "call-2"),
    { id: "divider", kind: "divider", createdAt },
    tool("orphan-start", "start", "call-3"),
  ];

  const rows = buildConversationRows(items);

  assert.deepEqual(
    rows.map((row) => [row.key, row.tools.map(({ start }) => start.id)]),
    [
      ["row:orphan-update", ["orphan-update"]],
      ["row:orphan-start", ["orphan-start"]],
    ],
  );
});

test("assigns turn copy text only to the final assistant row", () => {
  const first = message("a1", "assistant", "first");
  first.blocks = [
    { type: "thinking", thinking: "private" },
    { type: "text", text: "first" },
  ];
  const rows = buildConversationRows([
    message("u1", "user", "question"),
    first,
    message("a2", "assistant", "second"),
    message("u2", "user", "next"),
  ]);

  assert.equal(rows[1]?.copyText, undefined);
  assert.equal(rows[2]?.copyText, "first\nsecond");
  assert.equal(rows[2]?.isCurrentTurn, false);
});

test("marks only the trailing assistant turn as current", () => {
  const rows = buildConversationRows([
    message("u1", "user", "first question"),
    message("a1", "assistant", "first answer"),
    message("u2", "user", "second question"),
    message("a2", "assistant", "second answer"),
  ]);

  assert.equal(rows[1]?.isCurrentTurn, false);
  assert.equal(rows[3]?.isCurrentTurn, true);
});

test("coalesces tool updates at the first call position and pairs the final result", () => {
  const rows = buildConversationRows([
    message("a1", "assistant", "working"),
    { ...tool("start", "start", "call-1"), args: { command: "p" } },
    { ...tool("update-1", "update", "call-1"), args: { command: "pw" } },
    { ...tool("update-2", "update", "call-1"), args: { command: "pwd" } },
    { ...tool("end", "end", "call-1"), result: "ok" },
  ]);

  assert.equal(rows[0]?.tools.length, 1);
  assert.equal(rows[0]?.tools[0]?.start.id, "start");
  assert.deepEqual(rows[0]?.tools[0]?.start.args, { command: "pwd" });
  assert.equal(rows[0]?.tools[0]?.end?.id, "end");
});

test("preserves text, thinking, and tool positions within an assistant message", () => {
  const assistant = message("a1", "assistant", "beforeafter");
  assistant.blocks = [
    { type: "thinking", thinking: "reasoning" },
    { type: "text", text: "before" },
    { type: "tool", toolUseId: "call-1" },
    { type: "text", text: "after" },
  ];
  const [row] = buildConversationRows([
    assistant,
    tool("start", "start", "call-1"),
    tool("end", "end", "call-1"),
  ]);

  assert.ok(row);
  assert.deepEqual(
    buildConversationContentParts(row.message, row.tools).map((part) =>
      part.type === "tool" ? `tool:${part.tool.start.toolUseId}` : part.type,
    ),
    ["thinking", "text", "tool:call-1", "text"],
  );
});

test("keeps duplicate timeline ids unique and stable when older rows prepend", () => {
  const current = buildConversationRows([
    message("duplicate", "assistant", "newer duplicate"),
    message("current", "assistant", "current"),
  ]);
  const prepended = buildConversationRows([
    message("duplicate", "assistant", "older duplicate"),
    message("duplicate", "assistant", "newer duplicate"),
    message("current", "assistant", "current"),
  ]);

  assert.deepEqual(
    current.map(({ key }) => key),
    ["row:duplicate", "row:current"],
  );
  assert.deepEqual(
    prepended.map(({ key }) => key),
    ["row:duplicate:duplicate-1", "row:duplicate", "row:current"],
  );
});
