import { describe, expect, test } from "bun:test";
import type { ConversationSnippet } from "../blackboard/query-messages.ts";
import type { StreamRow } from "../contracts/index.ts";
import { buildClassificationPrompts } from "./classifier.ts";

function stream(overrides: Partial<StreamRow> = {}): StreamRow {
  return {
    id: "stream-1",
    name: "test-stream",
    repo_path: null,
    worktree_path: null,
    status: "open",
    created_at: "2026-05-03T07:00:00Z",
    closed_at: null,
    base_branch: null,
    ...overrides,
  };
}

function snippet(overrides: Partial<ConversationSnippet> = {}): ConversationSnippet {
  return {
    stream_id: "stream-1",
    stream_name: "test-stream",
    content: "message",
    source: "web",
    created_at: "2026-05-03T07:01:00Z",
    direction: "inbound",
    sender: "user",
    ...overrides,
  };
}

describe("buildClassificationPrompts", () => {
  test("renders stream snippets without source labels and documents newest-first ordering", () => {
    const prompts = buildClassificationPrompts(
      "continue",
      [stream()],
      new Map([
        [
          "stream-1",
          [
            snippet({
              source: "stream_outbound",
              direction: "outbound",
              sender: "pi",
              content: "Latest agent reply",
            }),
            snippet({ content: "Previous user message" }),
          ],
        ],
      ]),
    );

    expect(prompts.systemPrompt).toContain("Recent conversation snippets are shown newest first");
    expect(prompts.userPrompt).toContain("## Open streams — recent messages newest first");
    expect(prompts.userPrompt).toContain("Agent: Latest agent reply");
    expect(prompts.userPrompt).toContain("User: Previous user message");
    expect(prompts.userPrompt).not.toContain("[stream_outbound]");
    expect(prompts.userPrompt).not.toContain("[web]");
  });

  test("documents default routing for clear and reload commands", () => {
    const prompts = buildClassificationPrompts("/clear", [stream()], new Map());

    expect(prompts.systemPrompt).toContain(
      "If the user message is exactly /clear or /reload, return stream_id: null",
    );
  });

  test("allows longer snippets before truncating", () => {
    const content = "x".repeat(601);
    const prompts = buildClassificationPrompts(
      "continue",
      [stream()],
      new Map([["stream-1", [snippet({ content })]]]),
    );

    expect(prompts.userPrompt).toContain(`${"x".repeat(600)}…`);
    expect(prompts.userPrompt).not.toContain("x".repeat(601));
  });
});
