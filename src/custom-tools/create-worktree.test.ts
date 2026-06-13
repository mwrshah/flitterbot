import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BlackboardDatabase } from "../blackboard/db.ts";
import type { StreamRow } from "../blackboard/query-streams.ts";
import { executeCreateWorktree } from "./create-worktree.ts";

function fakeDb(stream: StreamRow): { db: BlackboardDatabase; getStream: () => StreamRow } {
  let current = { ...stream };
  return {
    getStream: () => current,
    db: {
      get(sql: string, ...args: unknown[]) {
        if (sql.includes("FROM streams") && args[0] === current.id) return current;
        return undefined;
      },
      prepare(sql: string) {
        return {
          run(...args: unknown[]) {
            if (sql.includes("UPDATE streams") && args.length >= 2) {
              current = {
                ...current,
                repo_path: args[0] as string,
                worktree_path: args[1] as string | null,
                base_branch: (args[2] as string | null | undefined) ?? current.base_branch,
              };
            }
            return { changes: 1 };
          },
          all: () => [],
          get: () => undefined,
        };
      },
      exec: () => {},
      transaction: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
    } as unknown as BlackboardDatabase,
  };
}

function createRepo(): { root: string; repo: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flit-cwt-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });
  return { root, repo };
}

describe("executeCreateWorktree", () => {
  test("discovery mode resolves repo from orchestrator cwd without creating a worktree", async () => {
    const { root, repo } = createRepo();
    try {
      const state = fakeDb({
        id: "stream-1",
        name: "feature",
        type: "work",
        repo_path: null,
        worktree_path: null,
        status: "open",
        created_at: "2026-01-01 00:00:00",
        closed_at: null,
        base_branch: null,
        pinned: false,
      });

      const result = await executeCreateWorktree(
        state.db,
        "stream-1",
        repo,
        undefined,
        false,
        true,
      );

      expect(result.ok).toBe(true);
      expect(result.message).toContain("Discovery dry-run");
      expect(result.message).toContain(repo);
      expect(state.getStream().worktree_path).toBe(null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
