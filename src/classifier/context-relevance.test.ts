import { describe, expect, mock, test } from "bun:test";
import { buildContextRelevancePrompts } from "../prompts/context-relevance.ts";
import {
  formatStreamPrompt,
  stripInjectedDatetimeBlocks,
} from "../streams/format-stream-prompt.ts";

// Mock groq-client before importing context-relevance
const mockCallGroqJson = mock<(apiKey: string, prompts: unknown) => Promise<unknown>>();
mock.module("./groq-client.ts", () => ({
  callGroqJson: (...args: unknown[]) => mockCallGroqJson(...(args as [string, unknown])),
}));

// --- Prompt builder tests ---

describe("buildContextRelevancePrompts", () => {
  test("includes stream name and all messages", () => {
    const messages = [
      { content: "Fix the login bug", created_at: "2026-03-26T10:00:00Z" },
      { content: "It happens on Chrome", created_at: "2026-03-26T10:01:00Z" },
    ];
    const prompts = buildContextRelevancePrompts(messages, "fix-login-bug");

    expect(prompts.userPrompt).toContain('"fix-login-bug"');
    expect(prompts.userPrompt).toContain("[Message 1]");
    // The last message is tagged "CURRENT" so rule #3 in the prompt can reference it.
    expect(prompts.userPrompt).toContain("[Message 2 \u2014 CURRENT]");
    expect(prompts.userPrompt).toContain("Fix the login bug");
    expect(prompts.userPrompt).toContain("It happens on Chrome");
  });

  test("includes optional agent context as stream purpose", () => {
    const prompts = buildContextRelevancePrompts(
      [{ content: "please do this", created_at: "2026-03-26T10:00:00Z" }],
      "fix-auth",
      "Fix the token refresh bug in the auth service",
    );

    expect(prompts.userPrompt).toContain("## Stream Purpose");
    expect(prompts.userPrompt).toContain("Fix the token refresh bug in the auth service");
  });

  test("instructs JSON response with relevant array and vague orchestration filtering", () => {
    const prompts = buildContextRelevancePrompts(
      [{ content: "test", created_at: "2026-03-26T10:00:00Z" }],
      "test-ws",
    );
    expect(prompts.systemPrompt).toContain('"relevant"');
    expect(prompts.systemPrompt).toContain("array of booleans");
    expect(prompts.systemPrompt).toContain("Omit vague user messages");
  });
});

// --- formatStreamPrompt tests ---

describe("formatStreamPrompt", () => {
  test("single message produces raw message + datetime tail", () => {
    const result = formatStreamPrompt(["Do the thing"], "my-ws", "ws-123");

    expect(result).toContain("Do the thing");
    expect(result).not.toContain("User message (");
    expect(result).not.toContain("[Stream:");
    expect(result).not.toContain("/tmux2");
    expect(result).toMatch(/^Do the thing\n\n\[Now: .+\]$/);
  });

  test("strips runtime-injected datetime blocks before stream prompt formatting", () => {
    const now = "[Now: Sunday, May 3, 2026 at 02:13 PM GMT+5]";

    expect(stripInjectedDatetimeBlocks(`${now}\nFix the stream timestamp placement`)).toBe(
      "Fix the stream timestamp placement",
    );
    expect(stripInjectedDatetimeBlocks(`Fix the stream timestamp placement\n\n${now}`)).toBe(
      "Fix the stream timestamp placement",
    );
    expect(
      stripInjectedDatetimeBlocks(`${now}\nFix the stream timestamp placement\n\n${now}`),
    ).toBe("Fix the stream timestamp placement");
  });

  test("multiple messages produces numbered format", () => {
    const result = formatStreamPrompt(
      ["First context", "Second context", "Create the feature"],
      "my-feature",
      "ws-456",
    );

    expect(result).not.toContain("[Stream:");
    expect(result).toContain("--- User message (1/3) ---");
    expect(result).toContain("--- User message (2/3) ---");
    expect(result).toContain("--- User message (3/3, most recent) ---");
    expect(result).toContain("First context");
    expect(result).toContain("Second context");
    expect(result).toContain("Create the feature");
    expect(result).not.toContain("/tmux2");
  });

  test("empty messages array produces just datetime", () => {
    const result = formatStreamPrompt([], "empty-ws", "ws-000");
    expect(result).not.toContain("[Stream:");
    expect(result).not.toContain("User message (");
    expect(result).not.toContain("/tmux2");
    expect(result).toMatch(/^\[Now: .+\]$/);
  });

  test("skipUserMessage batch mode: empty messages + agent context", () => {
    const result = formatStreamPrompt(
      [],
      "batch-ws",
      "ws-batch-1",
      "Investigate renewals pipeline failure in klair-api",
    );
    expect(result).not.toContain("User message (");
    expect(result).not.toContain("The following user messages provide context");
    expect(result).toContain("--- Agent context ---");
    expect(result).toContain("Investigate renewals pipeline failure in klair-api");
    expect(result).not.toContain("/tmux2");
  });
});

// --- classifyContextRelevance tests (mock Groq) ---

// Import after mock.module is set up
const { classifyContextRelevance } = await import("./context-relevance.ts");

describe("classifyContextRelevance", () => {
  test("returns boolean array from Groq response", async () => {
    mockCallGroqJson.mockImplementation(() => Promise.resolve({ relevant: [false, true, true] }));

    const messages = [
      { content: "Hello", created_at: "2026-03-26T10:00:00Z" },
      { content: "Fix auth", created_at: "2026-03-26T10:01:00Z" },
      { content: "Create stream for auth fix", created_at: "2026-03-26T10:02:00Z" },
    ];

    const result = await classifyContextRelevance(
      messages,
      "fix-auth",
      "fake-key",
      "Fix auth token refresh",
    );
    expect(result).toEqual([false, true, true]);
    expect(mockCallGroqJson).toHaveBeenCalledTimes(1);
  });

  test("throws on length mismatch", async () => {
    mockCallGroqJson.mockImplementation(() => Promise.resolve({ relevant: [true] }));

    const messages = [
      { content: "Hello", created_at: "2026-03-26T10:00:00Z" },
      { content: "Fix auth", created_at: "2026-03-26T10:01:00Z" },
    ];

    await expect(classifyContextRelevance(messages, "fix-auth", "fake-key")).rejects.toThrow(
      "Invalid context relevance response",
    );
  });
});
