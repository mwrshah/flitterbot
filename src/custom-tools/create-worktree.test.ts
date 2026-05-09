import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BlackboardDatabase } from "../blackboard/db.ts";
import type { StreamRow } from "../contracts/index.ts";
import { executeCreateWorktree } from "./create-worktree.ts";

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function createRepoWithExistingWorktree(): { root: string; repo: string; worktree: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flitterbot-create-worktree-"));
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "feature-worktree");
  fs.mkdirSync(repo);

  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "test@example.com"], repo);
  git(["config", "user.name", "Test User"], repo);
  fs.writeFileSync(path.join(repo, "README.md"), "test\n");
  git(["add", "README.md"], repo);
  git(["commit", "-m", "initial"], repo);
  git(["worktree", "add", "-b", "feature", worktree, "main"], repo);

  return { root, repo, worktree };
}

function fakeDb(stream: StreamRow): { db: BlackboardDatabase; getStream: () => StreamRow } {
  const holder = { stream };
  const db = {
    get: () => holder.stream,
    prepare: (sql: string) => ({
      run: (...args: unknown[]) => {
        if (sql.includes("base_branch")) {
          holder.stream = {
            ...holder.stream,
            repo_path: args[0] as string,
            worktree_path: args[1] as string | null,
            base_branch: args[2] as string | null,
          };
        } else if (sql.includes("worktree_path")) {
          holder.stream = {
            ...holder.stream,
            repo_path: args[0] as string,
            worktree_path: args[1] as string | null,
          };
        }
      },
    }),
  } as unknown as BlackboardDatabase;
  return { db, getStream: () => holder.stream };
}

describe("executeCreateWorktree", () => {
  test("records base_branch when the requested branch already has a worktree", async () => {
    const { root, repo, worktree } = createRepoWithExistingWorktree();
    try {
      const state = fakeDb({
        id: "stream-1",
        name: "feature",
        repo_path: repo,
        worktree_path: null,
        status: "open",
        created_at: "2026-01-01 00:00:00",
        closed_at: null,
        base_branch: null,
      });

      const result = await executeCreateWorktree(
        state.db,
        "stream-1",
        repo,
        repo,
        "feature",
        undefined,
        undefined,
        "main",
      );

      expect(result.ok).toBe(true);
      expect(result.worktreePath).toBe(worktree);
      expect(state.getStream().base_branch).toBe("main");
      expect(state.getStream().worktree_path).toBe(worktree);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
