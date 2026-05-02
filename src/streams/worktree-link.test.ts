import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BlackboardDatabase } from "../blackboard/db.ts";
import {
  checkWorktreeLink,
  clearWorktreePathIfStale,
  shouldReconcileWorktreeOnRecovery,
} from "./worktree-link.ts";

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function createRepoWithWorktree(): { root: string; repo: string; worktree: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flitterbot-worktree-link-"));
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "feature-worktree");
  fs.mkdirSync(repo);

  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "test@example.com"], repo);
  git(["config", "user.name", "Test User"], repo);
  fs.writeFileSync(path.join(repo, "README.md"), "test\n");
  git(["add", "README.md"], repo);
  git(["commit", "-m", "initial"], repo);
  git(["worktree", "add", "-b", "feature", worktree], repo);

  return { root, repo, worktree };
}

function fakeDb(): { db: BlackboardDatabase; updates: Array<{ sql: string; id: string }> } {
  const updates: Array<{ sql: string; id: string }> = [];
  const db = {
    prepare: (sql: string) => ({
      run: (id: string) => updates.push({ sql, id }),
    }),
  } as unknown as BlackboardDatabase;
  return { db, updates };
}

describe("worktree link recovery", () => {
  test("reconciles worktree links only for closed-stream reopen", () => {
    expect(shouldReconcileWorktreeOnRecovery("closed")).toBe(true);
    expect(shouldReconcileWorktreeOnRecovery("open")).toBe(false);
  });

  test("accepts an existing registered worktree with an attached branch", () => {
    const { root, repo, worktree } = createRepoWithWorktree();
    try {
      expect(checkWorktreeLink(worktree, repo)).toEqual({ ok: true, branch: "feature" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects missing and non-git worktree paths", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "flitterbot-worktree-link-"));
    try {
      expect(checkWorktreeLink(path.join(root, "missing"), null)).toEqual({
        ok: false,
        reason: "path does not exist",
      });
      const plainDir = path.join(root, "plain");
      fs.mkdirSync(plainDir);
      expect(checkWorktreeLink(plainDir, null)).toEqual({
        ok: false,
        reason: "path is not a git worktree",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves valid links and clears only genuinely stale links", () => {
    const { root, repo, worktree } = createRepoWithWorktree();
    try {
      const valid = fakeDb();
      expect(
        clearWorktreePathIfStale(valid.db, {
          id: "stream-valid",
          repo_path: repo,
          worktree_path: worktree,
        }),
      ).toEqual({ cleared: false, reason: "usable" });
      expect(valid.updates).toEqual([]);

      const stale = fakeDb();
      expect(
        clearWorktreePathIfStale(stale.db, {
          id: "stream-stale",
          repo_path: repo,
          worktree_path: path.join(root, "missing"),
        }),
      ).toEqual({
        cleared: true,
        reason: "path does not exist",
        previousPath: path.join(root, "missing"),
      });
      expect(stale.updates).toEqual([
        { sql: "UPDATE streams SET worktree_path = NULL WHERE id = ?", id: "stream-stale" },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
