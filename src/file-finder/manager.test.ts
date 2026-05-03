import { describe, expect, test } from "bun:test";
import { isFileFinderExcludedName, isFileFinderExcludedPath } from "./manager.ts";

describe("file finder exclusions", () => {
  test("excludes env-like names and private repo metadata directories", () => {
    expect(isFileFinderExcludedName(".env")).toBe(true);
    expect(isFileFinderExcludedName(".env.example")).toBe(true);
    expect(isFileFinderExcludedName(".envrc")).toBe(true);
    expect(isFileFinderExcludedName(".git")).toBe(true);
    expect(isFileFinderExcludedName(".github")).toBe(true);

    expect(isFileFinderExcludedName(".gitignore")).toBe(false);
    expect(isFileFinderExcludedName(".config")).toBe(false);
  });

  test("excludes paths below excluded segments", () => {
    expect(isFileFinderExcludedPath("src/index.ts")).toBe(false);
    expect(isFileFinderExcludedPath(".github/workflows/audit.yml")).toBe(true);
    expect(isFileFinderExcludedPath("packages/app/.git/config")).toBe(true);
    expect(isFileFinderExcludedPath("config/.env.d/secret")).toBe(true);
  });
});
