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

function addOrigin(root: string, repo: string): void {
  const origin = path.join(root, "origin.git");
  execFileSync("git", ["init", "--bare", origin], { stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: repo });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repo, stdio: "ignore" });
}

describe("executeCreateWorktree", () => {
  test("creates sibling worktree from main checkout when launched inside an existing worktree", async () => {
    const { root, repo } = createRepo();
    addOrigin(root, repo);
    const existingWorktree = path.join(root, "repo-worktrees", "001-existing");
    try {
      execFileSync("git", ["worktree", "add", existingWorktree, "-b", "001-existing"], {
        cwd: repo,
        stdio: "ignore",
      });
      const state = fakeDb({
        id: "stream-1",
        name: "Feature Work",
        type: "work",
        repo_path: null,
        worktree_path: null,
        status: "open",
        created_at: "2026-01-01 00:00:00",
        closed_at: null,
        base_branch: null,
        pinned: false,
      });

      execFileSync("git", ["config", "--add", "flitterbot.postCreate", "true"], { cwd: repo });

      const result = await executeCreateWorktree(state.db, "stream-1", existingWorktree, "main");

      const realRoot = fs.realpathSync(root);
      expect(result.ok).toBe(true);
      expect(result.worktreePath).toBe(path.join(realRoot, "repo-worktrees", "002-feature-work"));
      expect(state.getStream().repo_path).toBe(path.join(realRoot, "repo"));
      expect(state.getStream().worktree_path).toBe(result.worktreePath);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("unconfigured repo short-circuits to actionable discovery without creating a worktree", async () => {
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

      fs.writeFileSync(path.join(repo, ".env.local"), "SECRET=1\n");
      fs.writeFileSync(path.join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

      const result = await executeCreateWorktree(state.db, "stream-1", repo, "main");

      expect(result.ok).toBe(false);
      expect(result.message).toContain("NO worktree was created");
      expect(result.message).toContain(
        "First explore the repo context to suggest candidates for post-create hooks",
      );
      expect(result.message).toContain("3. Ask the user what the baseRef should be.");
      expect(result.message).toContain(".env.local");
      expect(result.message).toContain("pnpm install");
      expect(state.getStream().worktree_path).toBe(null);
      expect(fs.existsSync(path.join(root, "repo-worktrees"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("non-git cwd short-circuits to actionable discovery", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "flit-cwt-nongit-"));
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
      fs.writeFileSync(path.join(root, ".env"), "SECRET=1\n");
      fs.writeFileSync(path.join(root, "package-lock.json"), "{}\n");

      const result = await executeCreateWorktree(state.db, "stream-1", root);

      expect(result.ok).toBe(false);
      expect(result.message).toContain("is not inside a git repo");
      expect(result.message).toContain("NO worktree was created");
      expect(result.message).toContain("first identify the intended repository");
      expect(result.message).toContain(
        "Retry create_worktree from inside the intended git repository",
      );
      expect(result.message).not.toContain("Current [flitterbot] config: NONE");
      expect(result.message).not.toContain("Discovered env/secret files");
      expect(result.message).not.toContain(".env");
      expect(result.message).not.toContain("npm at /");
      expect(result.message).not.toContain("3. Ask the user what the baseRef should be.");
      expect(state.getStream().worktree_path).toBe(null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

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
