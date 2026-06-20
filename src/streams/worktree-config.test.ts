import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readWorktreeConfig, resolveBootstrapConfigSource } from "./worktree-config.ts";

function createRepo(): { root: string; repo: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flit-wtc-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });
  return { root, repo };
}

describe("resolveBootstrapConfigSource", () => {
  test("uses the pi session cwd repo even when no worktree exists", async () => {
    const { root, repo } = createRepo();
    try {
      execFileSync("git", ["config", "--add", "flitterbot.copyPath", ".env"], { cwd: repo });
      const cwd = path.join(repo, "src");
      fs.mkdirSync(cwd);

      const source = await resolveBootstrapConfigSource(cwd, null);
      const config = source ? await readWorktreeConfig(source) : null;

      expect(fs.realpathSync.native(source ?? "")).toBe(fs.realpathSync.native(repo));
      expect(config?.copyPaths).toEqual([".env"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses the git repo at cwd before considering a worktree fallback", async () => {
    const { root, repo } = createRepo();
    try {
      const worktree = path.join(root, "worktree");
      execFileSync("git", ["worktree", "add", worktree, "-b", "feature"], {
        cwd: repo,
        stdio: "ignore",
      });
      const source = await resolveBootstrapConfigSource(worktree, repo);

      expect(fs.realpathSync.native(source ?? "")).toBe(fs.realpathSync.native(worktree));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("falls back to the worktree's main repo when cwd is not a git repo", async () => {
    const { root, repo } = createRepo();
    try {
      execFileSync("git", ["config", "--add", "flitterbot.postCreate", "pnpm install"], {
        cwd: repo,
      });
      const worktree = path.join(root, "worktree");
      execFileSync("git", ["worktree", "add", worktree, "-b", "feature"], {
        cwd: repo,
        stdio: "ignore",
      });
      const outside = path.join(root, "outside");
      fs.mkdirSync(outside);

      const source = await resolveBootstrapConfigSource(outside, worktree);
      const config = source ? await readWorktreeConfig(source) : null;

      expect(fs.realpathSync.native(source ?? "")).toBe(fs.realpathSync.native(repo));
      expect(config?.postCreate).toEqual(["pnpm install"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
