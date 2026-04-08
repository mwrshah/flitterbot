import { exec as cpExec } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { BlackboardDatabase } from "../blackboard/db.ts";
import { enrichStream, getStreamById } from "../blackboard/query-streams.ts";

const execPromise = promisify(cpExec);

type CreateWorktreeResult = {
  ok: boolean;
  streamId: string;
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

const INSTALL_RULES: Array<{ files: string[]; cmd: string }> = [
  { files: ["pyproject.toml"], cmd: "uv sync" },
  { files: ["pnpm-lock.yaml"], cmd: "pnpm install" },
  { files: ["bun.lockb", "bun.lock"], cmd: "bun install" },
];

function detectInstallCmd(dir: string): string | null {
  for (const rule of INSTALL_RULES) {
    if (rule.files.some((f) => existsSync(path.join(dir, f)))) {
      return rule.cmd;
    }
  }
  return null;
}

async function installDependencies(worktreePath: string): Promise<string[]> {
  const dirs: Array<{ dir: string; cmd: string }> = [];

  // Check worktree root
  const rootCmd = detectInstallCmd(worktreePath);
  if (rootCmd) dirs.push({ dir: worktreePath, cmd: rootCmd });

  // Check immediate subdirectories
  try {
    for (const entry of readdirSync(worktreePath)) {
      const full = path.join(worktreePath, entry);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const cmd = detectInstallCmd(full);
      if (cmd) dirs.push({ dir: full, cmd });
    }
  } catch {
    // readdir failed — skip subdirectory scan
  }

  if (dirs.length === 0) return [];

  const results = await Promise.all(
    dirs.map(async ({ dir, cmd }) => {
      const label = dir === worktreePath ? "/" : path.basename(dir);
      try {
        await exec(cmd, dir, 120_000);
        return `${cmd} in ${label} (ok)`;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return `${cmd} in ${label} (failed: ${msg})`;
      }
    }),
  );
  return results;
}

const ENV_NAMES = new Set([".env", ".env.local"]);

function copyEnvFiles(repoPath: string, worktreePath: string): string[] {
  const copied: string[] = [];
  try {
    walkForEnv(repoPath, worktreePath, repoPath, 0, copied);
  } catch {
    // best-effort — never fail
  }
  return copied;
}

function walkForEnv(
  repoPath: string,
  worktreePath: string,
  dir: string,
  depth: number,
  copied: string[],
): void {
  if (depth > 2) return; // depth 0=root, 1=subdir, 2=subdir/subdir → 3 levels
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (ENV_NAMES.has(entry)) {
      try {
        if (!statSync(full).isFile()) continue;
      } catch {
        continue;
      }
      const rel = path.relative(repoPath, full);
      const dest = path.join(worktreePath, rel);
      if (existsSync(dest)) continue;
      try {
        mkdirSync(path.dirname(dest), { recursive: true });
        copyFileSync(full, dest);
        copied.push(rel);
      } catch {
        // skip this file
      }
    } else {
      // Recurse into subdirectories (skip hidden dirs and node_modules)
      if (entry.startsWith(".") || entry === "node_modules") continue;
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      walkForEnv(repoPath, worktreePath, full, depth + 1, copied);
    }
  }
}

export async function executeCreateWorktree(
  blackboard: BlackboardDatabase,
  streamId: string,
  repoPath: string,
  branchName?: string,
  updateRepoPath?: string,
  updateWorktreePath?: string,
): Promise<CreateWorktreeResult> {
  const stream = getStreamById(blackboard, streamId);
  if (!stream) {
    return {
      ok: false,
      streamId,
      message: `Stream ${streamId} not found`,
      usedGtr: false,
    };
  }
  if (stream.status !== "open") {
    return {
      ok: false,
      streamId,
      message: `Stream ${streamId} is not open`,
      usedGtr: false,
    };
  }

  // Enhancement 2: Field-only updates — skip all git operations
  if (updateRepoPath !== undefined || updateWorktreePath !== undefined) {
    const newRepo = updateRepoPath ?? stream.repo_path ?? repoPath;
    const newWorktree = updateWorktreePath ?? stream.worktree_path ?? undefined;
    enrichStream(blackboard, streamId, newRepo, newWorktree);
    return {
      ok: true,
      streamId,
      worktreePath: newWorktree,
      message: `Updated stream fields (repo_path=${newRepo}, worktree_path=${newWorktree ?? "null"})`,
      usedGtr: false,
    };
  }

  // Enhancement 1: Clean up orphaned worktree when switching repos
  let cleanupMessage = "";
  if (stream.worktree_path && stream.repo_path && stream.repo_path !== repoPath) {
    try {
      await exec(
        `git worktree remove ${JSON.stringify(stream.worktree_path)} --force`,
        stream.repo_path,
        15_000,
      );
      cleanupMessage = `Removed orphaned worktree at ${stream.worktree_path} (old repo: ${stream.repo_path}). `;
    } catch {
      cleanupMessage = `Warning: could not remove old worktree at ${stream.worktree_path}. `;
    }
  }

  // Enhancement 3: Reuse existing worktree if stream already has one on disk
  if (stream.worktree_path && existsSync(stream.worktree_path)) {
    enrichStream(blackboard, streamId, repoPath, stream.worktree_path);
    return {
      ok: true,
      streamId,
      worktreePath: stream.worktree_path,
      message: `${cleanupMessage}Existing worktree reused at ${stream.worktree_path}`,
      usedGtr: false,
    };
  }

  // Determine branch name: NNN-<slug> convention
  const slug = slugify(stream.name);
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
              enrichStream(blackboard, streamId, repoPath, existingPath);
              return {
                ok: true,
                streamId,
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

    enrichStream(blackboard, streamId, repoPath, result.worktreePath);

    // Best-effort dependency installation
    let installSummary = "";
    try {
      const installResults = await installDependencies(result.worktreePath);
      if (installResults.length > 0) {
        installSummary = `\nDeps: ${installResults.join(", ")}`;
      }
    } catch {
      // Never let install scanning fail the overall operation
    }

    // Best-effort env file copying
    const copiedEnvs = copyEnvFiles(repoPath, result.worktreePath);
    const envSummary =
      copiedEnvs.length > 0 ? `\nEnv: copied ${copiedEnvs.join(", ")}` : "\nEnv: none found";

    return {
      ok: true,
      streamId,
      worktreePath: result.worktreePath,
      branchName: resolvedBranch,
      message: `${cleanupMessage}Worktree created at ${result.worktreePath} on branch ${resolvedBranch}${useGtr ? "" : " (git gtr not available — used raw git worktree)"}${installSummary}${envSummary}`,
      usedGtr: useGtr,
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      streamId,
      message: `${cleanupMessage}Failed to create worktree: ${msg}`,
      usedGtr: useGtr,
    };
  }
}
