import assert from "node:assert/strict";
import test from "node:test";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { readStreamsHistoryFromSession } from "../src/streams/history.ts";
import { extractMessageBlocks } from "../src/streams/pi-subscribe.ts";

function sessionManagerWithContent(content: unknown[]): SessionManager {
  return {
    getSessionFile: () => null,
    getBranch: () => [
      {
        type: "message",
        id: "entry-1",
        parentId: null,
        timestamp: "2026-08-05T00:00:00.000Z",
        message: {
          role: "assistant",
          content,
        },
      },
    ],
  } as unknown as SessionManager;
}

test("history keeps text and tool calls in their original assistant block order", () => {
  const history = readStreamsHistoryFromSession(
    "session-1",
    sessionManagerWithContent([
      { type: "text", text: "before" },
      { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } },
      { type: "text", text: "after" },
    ]),
  );

  assert.deepEqual(history.items[0], {
    id: "entry-1",
    piEntryId: "entry-1",
    kind: "message",
    role: "assistant",
    content: "before\n\nafter",
    blocks: [
      { type: "text", text: "before" },
      { type: "tool", toolUseId: "call-1" },
      { type: "text", text: "after" },
    ],
    createdAt: "2026-08-05T00:00:00.000Z",
  });
  assert.deepEqual(history.items[1], {
    id: "tool-call-1-start",
    kind: "tool",
    tool: "bash",
    phase: "start",
    toolUseId: "call-1",
    args: { command: "pwd" },
    createdAt: "2026-08-05T00:00:00.000Z",
  });
});

test("live extraction keeps the same ordered tool references", () => {
  const extracted = extractMessageBlocks({
    role: "assistant",
    content: [
      { type: "text", text: "before" },
      { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } },
      { type: "text", text: "after" },
    ],
  });

  assert.equal(extracted.text, "before\n\nafter");
  assert.deepEqual(extracted.blocks, [
    { type: "text", text: "before" },
    { type: "tool", toolUseId: "call-1" },
    { type: "text", text: "after" },
  ]);
  assert.deepEqual(extracted.images, []);
  assert.deepEqual(extracted.toolCalls, [
    { toolUseId: "call-1", toolName: "bash", args: { command: "pwd" } },
  ]);
});

test("live extraction retains image-only messages", () => {
  const extracted = extractMessageBlocks({
    role: "user",
    content: [{ type: "image", data: "base64-data", mimeType: "image/png" }],
  });

  assert.equal(extracted.text, undefined);
  assert.deepEqual(extracted.blocks, []);
  assert.deepEqual(extracted.images, [{ data: "base64-data", mimeType: "image/png" }]);
});

test("history keeps thinking before a tool and text after it", () => {
  const history = readStreamsHistoryFromSession(
    "session-1",
    sessionManagerWithContent([
      { type: "thinking", thinking: "reasoning" },
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
      { type: "text", text: "answer" },
    ]),
  );

  const message = history.items[0];
  assert.equal(message?.kind, "message");
  if (message?.kind !== "message") return;
  assert.deepEqual(message.blocks, [
    { type: "thinking", thinking: "reasoning" },
    { type: "tool", toolUseId: "call-1" },
    { type: "text", text: "answer" },
  ]);
});
