import assert from "node:assert/strict";
import test from "node:test";
import { getAgentMessageRowKeys } from "../src/lib/agent-message-rows.ts";

type AgentMessage = Parameters<typeof getAgentMessageRowKeys>[0][number];

function message(value: Record<string, unknown>): AgentMessage {
  return value as AgentMessage;
}

test("builds stable rows only for visible user and assistant messages", () => {
  const user = message({ role: "user", content: "hello", _entryId: "entry-user" });
  const assistant = message({
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
    _entryId: "entry-assistant",
  });

  const keys = getAgentMessageRowKeys([
    user,
    message({ role: "toolResult", toolCallId: "tool-1" }),
    message({ role: "artifact" }),
    message({ role: "system", content: "hidden" }),
    assistant,
  ]);

  assert.deepEqual(keys, ["entry-user", "entry-assistant"]);
});

test("falls back to timestamp and render position when an entry id is unavailable", () => {
  const keys = getAgentMessageRowKeys([
    message({ role: "assistant", timestamp: 123 }),
    message({ role: "toolResult", timestamp: 124 }),
    message({ role: "assistant", timestamp: 123 }),
    message({ role: "user" }),
  ]);

  assert.deepEqual(keys, ["assistant:123:0", "assistant:123:1", "user:2"]);
});

test("disambiguates duplicate entry ids", () => {
  const keys = getAgentMessageRowKeys([
    message({ role: "assistant", _entryId: "same" }),
    message({ role: "assistant", _entryId: "same" }),
  ]);

  assert.deepEqual(keys, ["same", "same:1"]);
});
