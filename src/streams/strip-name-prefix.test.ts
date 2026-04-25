import { describe, expect, test } from "bun:test";
import { stripStreamNamePrefix } from "./strip-name-prefix.ts";

describe("stripStreamNamePrefix", () => {
  test("strips known prefixes once at the start", () => {
    expect(stripStreamNamePrefix("i-foo-bar")).toBe("foo-bar");
    expect(stripStreamNamePrefix("wr-foo-bar")).toBe("foo-bar");
    expect(stripStreamNamePrefix("bug-foo-bar")).toBe("foo-bar");
    expect(stripStreamNamePrefix("bs-foo-bar")).toBe("foo-bar");
    expect(stripStreamNamePrefix("fix-foo-bar")).toBe("foo-bar");
  });

  test("does not recurse — strips at most once", () => {
    expect(stripStreamNamePrefix("i-bug-foo")).toBe("bug-foo");
    expect(stripStreamNamePrefix("wr-i-foo")).toBe("i-foo");
  });

  test("does not touch mid-name occurrences", () => {
    expect(stripStreamNamePrefix("foo-i-bar")).toBe("foo-i-bar");
    expect(stripStreamNamePrefix("foo-bug-bar")).toBe("foo-bug-bar");
  });

  test("leaves names without a known prefix untouched", () => {
    expect(stripStreamNamePrefix("foo-bar")).toBe("foo-bar");
    expect(stripStreamNamePrefix("inv-foo")).toBe("inv-foo");
    expect(stripStreamNamePrefix("buggy-thing")).toBe("buggy-thing");
    expect(stripStreamNamePrefix("fixture-name")).toBe("fixture-name");
  });

  test("leaves bare prefix alone (nothing after)", () => {
    expect(stripStreamNamePrefix("i-")).toBe("i-");
    expect(stripStreamNamePrefix("bug-")).toBe("bug-");
  });
});
