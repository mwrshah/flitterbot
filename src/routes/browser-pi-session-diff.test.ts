import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import type { BlackboardDatabase } from "../blackboard/db.ts";
import type { StreamRow } from "../contracts/index.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { handleBrowserPiSessionDiffRoute } from "./browser-pi-session-diff.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function createRepo(): { root: string; repo: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flitterbot-pi-session-diff-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);

  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "test@example.com"], repo);
  git(["config", "user.name", "Test User"], repo);
  fs.writeFileSync(path.join(repo, "README.md"), "initial\n");
  git(["add", "README.md"], repo);
  git(["commit", "-m", "initial"], repo);
  git(["checkout", "-b", "feature"], repo);

  return { root, repo };
}

function createRuntime(worktreePath: string): ControlSurfaceRuntime {
  const stream: StreamRow = {
    id: "stream-1",
    name: "feature",
    repo_path: worktreePath,
    worktree_path: worktreePath,
    base_branch: "main",
    status: "open",
    created_at: "2026-01-01 00:00:00",
    closed_at: null,
  };
  const blackboard = {
    get: () => stream,
  } as unknown as BlackboardDatabase;
  return {
    blackboard,
    log: () => {},
  } as unknown as ControlSurfaceRuntime;
}

async function fetchDiff(worktreePath: string): Promise<{ statusCode: number; body: string }> {
  const runtime = createRuntime(worktreePath);
  let body = "";
  const response = {
    statusCode: 200,
    setHeader: () => {},
    end: (chunk?: string) => {
      body += chunk ?? "";
    },
  } as unknown as http.ServerResponse;

  await handleBrowserPiSessionDiffRoute(
    runtime,
    {} as http.IncomingMessage,
    response,
    "pi-session-1",
  );

  return { statusCode: response.statusCode, body };
}

describe("handleBrowserPiSessionDiffRoute", () => {
  test("includes untracked files in the base diff without staging them", async () => {
    const { root, repo } = createRepo();
    try {
      fs.writeFileSync(path.join(repo, "NEW.md"), "untracked file\n");

      const result = await fetchDiff(repo);
      const payload = JSON.parse(result.body) as { mode: "diff"; diff: string };

      expect(result.statusCode).toBe(200);
      expect(payload.mode).toBe("diff");
      expect(payload.diff).toContain("diff --git a/NEW.md b/NEW.md");
      expect(payload.diff).toContain("+untracked file");
      expect(git(["status", "--short"], repo)).toBe("?? NEW.md\n");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps tracked, staged, and untracked changes in the same diff", async () => {
    const { root, repo } = createRepo();
    try {
      fs.appendFileSync(path.join(repo, "README.md"), "unstaged change\n");
      fs.writeFileSync(path.join(repo, "STAGED.md"), "staged file\n");
      git(["add", "STAGED.md"], repo);
      fs.writeFileSync(path.join(repo, "UNTRACKED.md"), "untracked file\n");

      const result = await fetchDiff(repo);
      const payload = JSON.parse(result.body) as { mode: "diff"; diff: string };

      expect(result.statusCode).toBe(200);
      expect(payload.mode).toBe("diff");
      expect(payload.diff).toContain("diff --git a/README.md b/README.md");
      expect(payload.diff).toContain("+unstaged change");
      expect(payload.diff).toContain("diff --git a/STAGED.md b/STAGED.md");
      expect(payload.diff).toContain("+staged file");
      expect(payload.diff).toContain("diff --git a/UNTRACKED.md b/UNTRACKED.md");
      expect(payload.diff).toContain("+untracked file");
      expect(git(["status", "--short"], repo)).toBe(
        " M README.md\nA  STAGED.md\n?? UNTRACKED.md\n",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
