import { exec as cpExec } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { BlackboardDatabase } from "../blackboard/db.ts";
import { enrichWorkstream, getWorkstreamById } from "../blackboard/query-workstreams.ts";

const execPromise = promisify(cpExec);

type CreateWorktreeResult = {
  ok: boolean;
  workstreamId: string;
  worktreePath?: string;
  branchName?: string;
  message: string;
  usedGtr: boolean;
};

async function exec(cmd: string, cwd: string, timeoutMs = 30_000): Promise<string> {
  const { stdout } = await execPromise(cmd, { cwd, timeout: timeoutMs });
  return stdout.trim();
}

async function hasGtr(repoPath: string): Promise<boolean> {
  try {
    await execPromise("git gtr version", { cwd: repoPath, timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function getHighestBranchNumber(repoPath: string): Promise<number> {
  try {
    const output = await exec(
      "git for-each-ref --format='%(refname:short)' refs/heads/ refs/remotes/origin/",
      repoPath,
      10_000,
    );
    if (!output) return 0;
    const numbers = output
      .split("\n")
      .map((name) => name.replace(/^origin\//, ""))
      .map((name) => {
        const match = name.match(/^(\d+)-/);
        return match ? parseInt(match[1]!, 10) : Number.NaN;
      })
      .filter((n) => !Number.isNaN(n));
    return numbers.length > 0 ? Math.max(...numbers) : 0;
  } catch {
    return 0;
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function resolveGtrWorktreePath(repoPath: string, branchName: string): Promise<string> {
  try {
    const output = await exec(`git gtr go ${branchName}`, repoPath, 5_000);
    if (output) return output;
  } catch {
    // fall through to convention
  }
  // gtr convention: <repo>-worktrees/<branch>
  const repoDir = path.basename(repoPath);
  return path.resolve(repoPath, "..", `${repoDir}-worktrees`, branchName);
}

async function createWithGtr(
  repoPath: string,
  branchName: string,
): Promise<{ worktreePath: string }> {
  await exec(`git gtr new ${branchName} --yes`, repoPath, 60_000);
  const worktreePath = await resolveGtrWorktreePath(repoPath, branchName);
  return { worktreePath };
}

async function createWithRawGit(
  repoPath: string,
  branchName: string,
): Promise<{ worktreePath: string }> {
  const repoDir = path.basename(repoPath);
  const worktreePath = path.resolve(repoPath, "..", `${repoDir}-worktrees`, branchName);
  await exec("git fetch origin", repoPath, 30_000);
  await exec(
    `git worktree add ${JSON.stringify(worktreePath)} -b ${JSON.stringify(branchName)} origin/main`,
    repoPath,
    30_000,
  );
  return { worktreePath };
}

export async function executeCreateWorktree(
  blackboard: BlackboardDatabase,
  workstreamId: string,
  repoPath: string,
  branchName?: string,
  updateRepoPath?: string,
  updateWorktreePath?: string,
): Promise<CreateWorktreeResult> {
  const workstream = getWorkstreamById(blackboard, workstreamId);
  if (!workstream) {
    return {
      ok: false,
      workstreamId,
      message: `Workstream ${workstreamId} not found`,
      usedGtr: false,
    };
  }
  if (workstream.status !== "open") {
    return {
      ok: false,
      workstreamId,
      message: `Workstream ${workstreamId} is not open`,
      usedGtr: false,
    };
  }

  // Enhancement 2: Field-only updates — skip all git operations
  if (updateRepoPath !== undefined || updateWorktreePath !== undefined) {
    const newRepo = updateRepoPath ?? workstream.repo_path ?? repoPath;
    const newWorktree = updateWorktreePath ?? workstream.worktree_path ?? undefined;
    enrichWorkstream(blackboard, workstreamId, newRepo, newWorktree);
    return {
      ok: true,
      workstreamId,
      worktreePath: newWorktree,
      message: `Updated workstream fields (repo_path=${newRepo}, worktree_path=${newWorktree ?? "null"})`,
      usedGtr: false,
    };
  }

  // Enhancement 1: Clean up orphaned worktree when switching repos
  let cleanupMessage = "";
  if (workstream.worktree_path && workstream.repo_path && workstream.repo_path !== repoPath) {
    try {
      await exec(
        `git worktree remove ${JSON.stringify(workstream.worktree_path)} --force`,
        workstream.repo_path,
        15_000,
      );
      cleanupMessage = `Removed orphaned worktree at ${workstream.worktree_path} (old repo: ${workstream.repo_path}). `;
    } catch {
      cleanupMessage = `Warning: could not remove old worktree at ${workstream.worktree_path}. `;
    }
  }

  // Enhancement 3: Reuse existing worktree if workstream already has one on disk
  if (workstream.worktree_path && existsSync(workstream.worktree_path)) {
    enrichWorkstream(blackboard, workstreamId, repoPath, workstream.worktree_path);
    return {
      ok: true,
      workstreamId,
      worktreePath: workstream.worktree_path,
      message: `${cleanupMessage}Existing worktree reused at ${workstream.worktree_path}`,
      usedGtr: false,
    };
  }

  // Determine branch name: NNN-<slug> convention
  const slug = slugify(workstream.name);
  let resolvedBranch: string;
  if (branchName) {
    resolvedBranch = branchName;
  } else {
    const nextNum = (await getHighestBranchNumber(repoPath)) + 1;
    resolvedBranch = `${String(nextNum).padStart(3, "0")}-${slug}`;
  }

  // Check if branch already has a worktree
  try {
    const worktrees = await exec("git worktree list --porcelain", repoPath, 10_000);
    if (worktrees.includes(`branch refs/heads/${resolvedBranch}`)) {
      // Already checked out — find the path
      const lines = worktrees.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === `branch refs/heads/${resolvedBranch}`) {
          // worktree path is a few lines before (the "worktree <path>" line)
          for (let j = i; j >= 0; j--) {
            if (lines[j]!.startsWith("worktree ")) {
              const existingPath = lines[j]!.slice("worktree ".length);
              enrichWorkstream(blackboard, workstreamId, repoPath, existingPath);
              return {
                ok: true,
                workstreamId,
                worktreePath: existingPath,
                branchName: resolvedBranch,
                message: `${cleanupMessage}Worktree already exists at ${existingPath} on branch ${resolvedBranch}`,
                usedGtr: false,
              };
            }
          }
        }
      }
    }
  } catch {
    // ignore — proceed to create
  }

  const useGtr = await hasGtr(repoPath);
  try {
    const result = useGtr
      ? await createWithGtr(repoPath, resolvedBranch)
      : await createWithRawGit(repoPath, resolvedBranch);

    // Register Git Town parent if git-town is available
    try {
      await exec(`git config "git-town-branch.${resolvedBranch}.parent" main`, repoPath, 5_000);
    } catch {
      // Git Town not installed — fine
    }

    enrichWorkstream(blackboard, workstreamId, repoPath, result.worktreePath);

    return {
      ok: true,
      workstreamId,
      worktreePath: result.worktreePath,
      branchName: resolvedBranch,
      message: `${cleanupMessage}Worktree created at ${result.worktreePath} on branch ${resolvedBranch}${useGtr ? "" : " (git gtr not available — used raw git worktree)"}`,
      usedGtr: useGtr,
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      workstreamId,
      message: `${cleanupMessage}Failed to create worktree: ${msg}`,
      usedGtr: useGtr,
    };
  }
}
