import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationRow } from "../src/lib/conversation-rows.ts";
import { activeUserMessageIdForViewport } from "../src/lib/user-message-markers.ts";

function row(id: string, role: "user" | "assistant"): ConversationRow {
  return {
    key: id,
    tools: [],
    message: {
      id,
      kind: "message",
      role,
      content: id,
      createdAt: "2026-09-13T00:00:00.000Z",
    },
  };
}

test("active marker ignores mounted user messages above the visible viewport", () => {
  const rows = [
    row("offscreen-user", "user"),
    row("assistant", "assistant"),
    row("visible-user", "user"),
  ];
  const virtualItems = [
    { index: 0, start: 0, end: 90 },
    { index: 1, start: 90, end: 200 },
    { index: 2, start: 200, end: 260 },
  ];

  assert.equal(
    activeUserMessageIdForViewport(
      rows,
      [
        { id: "offscreen-user", content: "Older preview" },
        { id: "visible-user", content: "Visible preview" },
      ],
      virtualItems,
      100,
      240,
    ),
    "visible-user",
  );
  assert.equal(
    activeUserMessageIdForViewport(
      rows,
      [
        { id: "offscreen-user", content: "Older preview" },
        { id: "visible-user", content: "Visible preview" },
      ],
      virtualItems,
      100,
      190,
    ),
    "offscreen-user",
  );
});

test("active marker uses the geometrically topmost visible user message", () => {
  const rows = [row("top-user", "user"), row("lower-user", "user")];
  const virtualItems = [
    { index: 1, start: 180, end: 260 },
    { index: 0, start: 100, end: 180 },
  ];

  assert.equal(
    activeUserMessageIdForViewport(
      rows,
      [
        { id: "top-user", content: "Top preview" },
        { id: "lower-user", content: "Lower preview" },
      ],
      virtualItems,
      100,
      240,
    ),
    "top-user",
  );
});
