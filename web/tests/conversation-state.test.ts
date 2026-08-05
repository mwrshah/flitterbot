import assert from "node:assert/strict";
import test from "node:test";
import { conversationState } from "../src/lib/conversation-state.ts";

test("loader live snapshot installs accumulated streaming and tool state", () => {
  const sessionId = "loader-live-state";
  conversationState.installSnapshot(sessionId, {
    streaming: {
      messageId: "assistant-1",
      text: "answer",
      thinking: "reason",
      thinkingActive: true,
    },
    tools: [{ toolUseId: "tool-1", pending: true, partialResult: "partial" }],
  });

  assert.deepEqual(conversationState.streamingSnapshot(sessionId), {
    messageId: "assistant-1",
    text: "answer",
    thinking: "reason",
    thinkingActive: true,
  });
  assert.deepEqual(conversationState.toolSnapshot(sessionId, "tool-1"), {
    toolUseId: "tool-1",
    pending: true,
    partialResult: "partial",
  });
  conversationState.clear(sessionId);
});

test("events after the loader cursor extend installed streaming state", () => {
  const sessionId = "loader-live-continuation";
  conversationState.installSnapshot(sessionId, {
    streaming: {
      messageId: "assistant-1",
      text: "before",
      thinking: "",
      thinkingActive: false,
    },
    tools: [],
  });
  conversationState.textDelta(sessionId, "assistant-1", " after");

  assert.equal(conversationState.streamingSnapshot(sessionId)?.text, "before after");
  conversationState.clear(sessionId);
});
