import { describe, expect, test } from "bun:test";
import { formatStartupFailure } from "./startup-error.ts";

describe("formatStartupFailure", () => {
  test("keeps the startup failure reason as the final line", () => {
    const error = new Error("Invalid startup config /home/user/.flitterbot/config.json");
    const formatted = formatStartupFailure(error);

    expect(formatted).toContain("FATAL control surface startup failed");
    expect(formatted.split("\n").at(-1)).toBe(
      "Reason: Invalid startup config /home/user/.flitterbot/config.json",
    );
  });
});
