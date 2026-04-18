import { describe, expect, mock, test } from "bun:test";
import { buildContextRelevancePrompt } from "../prompts/context-relevance.ts";
import { formatStreamPrompt } from "../streams/format-stream-prompt.ts";

// Mock groq-client before importing context-relevance
const mockCallGroqJson = mock<(apiKey: string, prompt: string) => Promise<unknown>>();
mock.module("./groq-client.ts", () => ({
  callGroqJson: (...args: unknown[]) => mockCallGroqJson(...(args as [string, string])),
}));

// --- Prompt builder tests ---

describe("buildContextRelevancePrompt", () => {
  test("includes stream name and all messages", () => {
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

// --- formatStreamPrompt tests ---

describe("formatStreamPrompt", () => {
  test("single message produces simple format with default footer", () => {
    const result = formatStreamPrompt(["Do the thing"], "my-ws", "ws-123");

    expect(result).toContain("Do the thing");
    expect(result).toContain("/tmux2");
    expect(result).not.toContain("User message (");
    expect(result).not.toContain("[Stream:");
  });

  test("multiple messages produces numbered format with default footer", () => {
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
    expect(result).toContain("/tmux2");
  });

  test("empty messages array produces footer only", () => {
    const result = formatStreamPrompt([], "empty-ws", "ws-000");
    expect(result).not.toContain("[Stream:");
    expect(result).toContain("/tmux2");
  });

  test("skipUserMessage batch mode: empty messages + agent context", () => {
    const result = formatStreamPrompt(
      [],
      "batch-ws",
      "ws-batch-1",
      "Investigate renewals pipeline failure in klair-api",
      "Load /tmux2",
    );
    expect(result).not.toContain("User message (");
    expect(result).not.toContain("The following user messages provide context");
    expect(result).toContain("--- Agent context ---");
    expect(result).toContain("Investigate renewals pipeline failure in klair-api");
    expect(result).toContain("Load /tmux2");
  });

  test("custom footer overrides default", () => {
    const result = formatStreamPrompt(
      ["Hello"],
      "ws",
      "ws-1",
      undefined,
      "Load /custom-skill first",
    );
    expect(result).toContain("Load /custom-skill first");
    expect(result).not.toContain("/tmux2");
  });

  test("empty footer omits footer section", () => {
    const result = formatStreamPrompt(["Hello"], "ws", "ws-1", undefined, "");
    expect(result).not.toContain("IMPORTANT");
    expect(result).toBe("Hello");
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
