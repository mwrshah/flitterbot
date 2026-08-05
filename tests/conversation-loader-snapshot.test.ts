import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketHub } from "../src/ws/hub.ts";

test("conversation snapshot coalesces accumulated live state at one resume cursor", () => {
  const hub = new WebSocketHub();
  const piSessionId = "snapshot-session";

  hub.broadcast({
    type: "thinking_start",
    piSessionId,
    messageId: "assistant-1",
  });
  hub.broadcast({
    type: "thinking_delta",
    piSessionId,
    messageId: "assistant-1",
    delta: "reason",
  });
  hub.broadcast({
    type: "text_delta",
    piSessionId,
    messageId: "assistant-1",
    delta: "answer",
  });
  hub.broadcast({
    type: "tool_execution_update",
    piSessionId,
    toolUseId: "tool-1",
    partialResult: "partial",
    timestamp: new Date().toISOString(),
  });

  const snapshot = hub.conversationSnapshot(piSessionId);
  assert.equal(snapshot.resumePosition.sequence, 4);
  assert.deepEqual(snapshot.live.streaming, {
    messageId: "assistant-1",
    text: "answer",
    thinking: "reason",
    thinkingActive: true,
  });
  assert.deepEqual(snapshot.live.tools, [
    { toolUseId: "tool-1", pending: true, partialResult: "partial", isError: undefined },
  ]);
});

test("canonical completion removes loader live state", () => {
  const hub = new WebSocketHub();
  const piSessionId = "completed-session";
  hub.broadcast({ type: "text_delta", piSessionId, messageId: "assistant-1", delta: "done" });
  hub.broadcast({
    type: "message_end",
    piSessionId,
    message: {
      id: "assistant-1",
      kind: "message",
      role: "assistant",
      content: "done",
      createdAt: new Date().toISOString(),
    },
  });

  const snapshot = hub.conversationSnapshot(piSessionId);
  assert.equal(snapshot.resumePosition.sequence, 2);
  assert.equal(snapshot.live.streaming, undefined);
});
