import { describe, expect, mock, test } from "bun:test";
import { formatWorkstreamPrompt } from "../pi/format-workstream-prompt.ts";
import { buildContextRelevancePrompt } from "../prompts/context-relevance.ts";

// Mock groq-client before importing context-relevance
const mockCallGroqJson = mock<(apiKey: string, prompt: string) => Promise<unknown>>();
mock.module("./groq-client.ts", () => ({
  callGroqJson: (...args: unknown[]) => mockCallGroqJson(...(args as [string, string])),
}));

// --- Prompt builder tests ---

describe("buildContextRelevancePrompt", () => {
  test("includes workstream name and all messages", () => {
    const messages = [
      { content: "Fix the login bug", created_at: "2026-03-26T10:00:00Z" },
      { content: "It happens on Chrome", created_at: "2026-03-26T10:01:00Z" },
    ];
    const prompt = buildContextRelevancePrompt(messages, "fix-login-bug");

    expect(prompt).toContain('"fix-login-bug"');
    expect(prompt).toContain("[Message 1]");
    expect(prompt).toContain("[Message 2]");
    expect(prompt).toContain("Fix the login bug");
    expect(prompt).toContain("It happens on Chrome");
  });

  test("instructs JSON response with relevant array", () => {
    const prompt = buildContextRelevancePrompt(
      [{ content: "test", created_at: "2026-03-26T10:00:00Z" }],
      "test-ws",
    );
    expect(prompt).toContain('"relevant"');
    expect(prompt).toContain("array of booleans");
  });
});

// --- formatWorkstreamPrompt tests ---

describe("formatWorkstreamPrompt", () => {
  test("single message produces simple format", () => {
    const result = formatWorkstreamPrompt(["Do the thing"], "my-ws", "ws-123");

    expect(result).toContain('[Workstream: "my-ws" (ws-123)] [NEW]');
    expect(result).toContain("Do the thing");
    expect(result).toContain("/load2-w");
    expect(result).not.toContain("User message (");
  });

  test("multiple messages produces numbered format", () => {
    const result = formatWorkstreamPrompt(
      ["First context", "Second context", "Create the feature"],
      "my-feature",
      "ws-456",
    );

    expect(result).toContain('[Workstream: "my-feature" (ws-456)] [NEW]');
    expect(result).toContain("--- User message (1/3) ---");
    expect(result).toContain("--- User message (2/3) ---");
    expect(result).toContain("--- User message (3/3, most recent) ---");
    expect(result).toContain("First context");
    expect(result).toContain("Second context");
    expect(result).toContain("Create the feature");
    expect(result).toContain("/load2-w");
  });

  test("empty messages array produces header only", () => {
    const result = formatWorkstreamPrompt([], "empty-ws", "ws-000");
    expect(result).toContain('[Workstream: "empty-ws" (ws-000)] [NEW]');
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
      { content: "Create workstream for auth fix", created_at: "2026-03-26T10:02:00Z" },
    ];

    const result = await classifyContextRelevance(messages, "fix-auth", "fake-key");
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
