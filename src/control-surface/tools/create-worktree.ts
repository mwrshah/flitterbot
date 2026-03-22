import { execSync } from "node:child_process";
import path from "node:path";
import type { BlackboardDatabase } from "../../blackboard/db.ts";
import { enrichWorkstream, getWorkstreamById } from "../../blackboard/queries/workstreams.ts";

type CreateWorktreeResult = {
  ok: boolean;
  workstreamId: string;
  worktreePath?: string;
  branchName?: string;
  message: string;
  usedGtr: boolean;
};

function hasGtr(repoPath: string): boolean {
  try {
    execSync("git gtr version", { cwd: repoPath, timeout: 5_000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function getHighestBranchNumber(repoPath: string): number {
  try {
    const output = execSync("git branch --list '[0-9]*'", {
      cwd: repoPath,
      timeout: 10_000,
      stdio: "pipe",
    })
      .toString()
      .trim();
    if (!output) return 0;
    const numbers = output
      .split("\n")
      .map((line) => line.replace(/^[* ]+/, "").trim())
      .map((name) => parseInt(name, 10))
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

function resolveGtrWorktreePath(repoPath: string, branchName: string): string {
  try {
    const output = execSync(`git gtr go ${branchName}`, {
      cwd: repoPath,
      timeout: 5_000,
      stdio: "pipe",
    })
      .toString()
      .trim();
    if (output) return output;
  } catch {
    // fall through to convention
  }
  // gtr convention: <repo>-worktrees/<branch>
  const repoDir = path.basename(repoPath);
  return path.resolve(repoPath, "..", `${repoDir}-worktrees`, branchName);
}

function createWithGtr(repoPath: string, branchName: string): { worktreePath: string } {
  execSync(`git gtr new ${branchName} --yes`, { cwd: repoPath, timeout: 60_000, stdio: "pipe" });
  const worktreePath = resolveGtrWorktreePath(repoPath, branchName);
  return { worktreePath };
}

function createWithRawGit(repoPath: string, branchName: string): { worktreePath: string } {
  const repoDir = path.basename(repoPath);
  const worktreePath = path.resolve(repoPath, "..", `${repoDir}-worktrees`, branchName);
  execSync("git fetch origin", { cwd: repoPath, timeout: 30_000, stdio: "pipe" });
  execSync(
    `git worktree add ${JSON.stringify(worktreePath)} -b ${JSON.stringify(branchName)} origin/main`,
    { cwd: repoPath, timeout: 30_000, stdio: "pipe" },
  );
  return { worktreePath };
}

export function executeCreateWorktree(
  blackboard: BlackboardDatabase,
  workstreamId: string,
  repoPath: string,
  branchName?: string,
): CreateWorktreeResult {
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

  // Determine branch name: NNN-<slug> convention
  const slug = slugify(workstream.name);
  let resolvedBranch: string;
  if (branchName) {
    resolvedBranch = branchName;
  } else {
    const nextNum = getHighestBranchNumber(repoPath) + 1;
    resolvedBranch = `${String(nextNum).padStart(3, "0")}-${slug}`;
  }

  // Check if branch already has a worktree
  try {
    const worktrees = execSync("git worktree list --porcelain", {
      cwd: repoPath,
      timeout: 10_000,
      stdio: "pipe",
    }).toString();
    if (worktrees.includes(`branch refs/heads/${resolvedBranch}`)) {
      // Already checked out — find the path
      const lines = worktrees.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === `branch refs/heads/${resolvedBranch}`) {
          // worktree path is a few lines before (the "worktree <path>" line)
          for (let j = i; j >= 0; j--) {
            if (lines[j].startsWith("worktree ")) {
              const existingPath = lines[j].slice("worktree ".length);
              enrichWorkstream(blackboard, workstreamId, repoPath, existingPath);
              return {
                ok: true,
                workstreamId,
                worktreePath: existingPath,
                branchName: resolvedBranch,
                message: `Worktree already exists at ${existingPath} on branch ${resolvedBranch}`,
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

  const useGtr = hasGtr(repoPath);
  try {
    const result = useGtr
      ? createWithGtr(repoPath, resolvedBranch)
      : createWithRawGit(repoPath, resolvedBranch);

    // Register Git Town parent if git-town is available
    try {
      execSync(`git config "git-town-branch.${resolvedBranch}.parent" main`, {
        cwd: repoPath,
        timeout: 5_000,
        stdio: "pipe",
      });
    } catch {
      // Git Town not installed — fine
    }

    enrichWorkstream(blackboard, workstreamId, repoPath, result.worktreePath);

    return {
      ok: true,
      workstreamId,
      worktreePath: result.worktreePath,
      branchName: resolvedBranch,
      message: `Worktree created at ${result.worktreePath} on branch ${resolvedBranch}${useGtr ? "" : " (git gtr not available — used raw git worktree)"}`,
      usedGtr: useGtr,
    };
  } catch (error: any) {
    return {
      ok: false,
      workstreamId,
      message: `Failed to create worktree: ${error.stderr?.toString().trim() || error.message}`,
      usedGtr: useGtr,
    };
  }
}
