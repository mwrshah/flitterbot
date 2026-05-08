import { describe, expect, test } from "bun:test";
import { formatStreamPrompt } from "./format-stream-prompt.ts";

describe("formatStreamPrompt", () => {
  test("appends configured stream footer to a single-message prompt", () => {
    const prompt = formatStreamPrompt(
      ["Fix the router"],
      "router-fix",
      "stream-1",
      "Use existing tests",
      "Run the configured stream setup.",
    );

    expect(prompt).toContain("Fix the router");
    expect(prompt).toContain("--- Agent context ---\nUse existing tests");
    expect(prompt).toContain("--- Flitterbot stream setup ---\nRun the configured stream setup.");
    expect(prompt).toMatch(/\[Now: .+\]$/);
  });

  test("appends configured stream footer to a multi-message prompt", () => {
    const prompt = formatStreamPrompt(
      ["First", "Second"],
      "router-fix",
      "stream-1",
      undefined,
      "Run the configured stream setup.",
    );

    expect(prompt).toContain("--- User message (1/2) ---\nFirst");
    expect(prompt).toContain("--- User message (2/2, most recent) ---\nSecond");
    expect(prompt).toContain("--- Flitterbot stream setup ---\nRun the configured stream setup.");
  });
});
