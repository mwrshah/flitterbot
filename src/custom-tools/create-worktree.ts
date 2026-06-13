import { exec as cpExec } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { BlackboardDatabase } from "../blackboard/db.ts";
import { enrichStream, getStreamById } from "../blackboard/query-streams.ts";
import {
  buildDiscoveryAdvisory,
  isConfigured,
  readWorktreeConfig,
  type WorktreeBootstrapConfig,
} from "../streams/worktree-config.ts";

const execPromise = promisify(cpExec);

type CreateWorktreeResult = {
  ok: boolean;
  streamId: string;
  worktreePath?: string;
  branchName?: string;
  message: string;
};

async function exec(cmd: string, cwd: string, timeoutMs = 30_000): Promise<string> {
  const { stdout } = await execPromise(cmd, { cwd, timeout: timeoutMs });
  return stdout.trim();
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

async function createWorktree(
  repoPath: string,
  branchName: string,
  baseRef: string,
): Promise<{ worktreePath: string }> {
  const repoDir = path.basename(repoPath);
  const worktreePath = path.resolve(repoPath, "..", `${repoDir}-worktrees`, branchName);
  await exec("git fetch origin", repoPath, 30_000);
  await exec(
    `git worktree add ${JSON.stringify(worktreePath)} -b ${JSON.stringify(branchName)} ${JSON.stringify(baseRef)}`,
    repoPath,
    30_000,
  );
  return { worktreePath };
}

// Copy each configured path (file or dir) from the main repo into the worktree. Runs BEFORE
// postCreate hooks so install/build steps see the env/secret files they need.
function runCopyPaths(repoPath: string, worktreePath: string, copyPaths: string[]): string[] {
  const results: string[] = [];
  for (const rel of copyPaths) {
    const src = path.resolve(repoPath, rel);
    const dest = path.resolve(worktreePath, rel);
    if (!src.startsWith(repoPath) || !dest.startsWith(worktreePath)) {
      results.push(`${rel} (skipped: escapes repo)`);
      continue;
    }
    if (!existsSync(src)) {
      results.push(`${rel} (skipped: not found in main repo)`);
      continue;
    }
    try {
      mkdirSync(path.dirname(dest), { recursive: true });
      cpSync(src, dest, { recursive: true });
      results.push(`${rel} (ok)`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      results.push(`${rel} (failed: ${msg})`);
    }
  }
  return results;
}

// Run postCreate hooks sequentially in declared order (ordering matters: install before build),
// each with cwd = worktree root. Best-effort: a failing hook never fails worktree creation.
async function runPostCreate(worktreePath: string, postCreate: string[]): Promise<string[]> {
  const results: string[] = [];
  for (const cmd of postCreate) {
    try {
      await exec(cmd, worktreePath, 300_000);
      results.push(`${cmd} (ok)`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      results.push(`${cmd} (failed: ${msg})`);
    }
  }
  return results;
}

function runBootstrap(
  repoPath: string,
  worktreePath: string,
  config: WorktreeBootstrapConfig,
): Promise<string> {
  const copyResults = runCopyPaths(repoPath, worktreePath, config.copyPaths);
  return runPostCreate(worktreePath, config.postCreate).then((hookResults) => {
    const parts: string[] = [];
    if (copyResults.length > 0) parts.push(`\nCopied: ${copyResults.join(", ")}`);
    if (hookResults.length > 0) parts.push(`\npostCreate: ${hookResults.join(", ")}`);
    return parts.join("");
  });
}

// Resolve the checked-out branch at a path, or null if the path is missing, not a repo, or on a
// detached HEAD. Never throws — base_ref resolution tries cwd then repo_path and only fails if both
// come back null, so the caller stays in control of the fallback chain.
async function tryHeadBranch(dir: string): Promise<string | null> {
  if (!existsSync(dir)) return null;
  let branch: string;
  try {
    branch = (await exec("git rev-parse --abbrev-ref HEAD", dir, 5_000)).trim();
  } catch {
    return null;
  }
  if (!branch || branch === "HEAD") return null;
  return branch;
}

export async function executeCreateWorktree(
  blackboard: BlackboardDatabase,
  streamId: string,
  orchestratorCwd: string,
  baseRef?: string,
  force = false,
  discovery = false,
): Promise<CreateWorktreeResult> {
  const stream = getStreamById(blackboard, streamId);
  if (!stream) {
    return {
      ok: false,
      streamId,
      message: `Stream ${streamId} not found`,
    };
  }
  if (stream.status !== "open") {
    return {
      ok: false,
      streamId,
      message: `Stream ${streamId} is not open`,
    };
  }

  // repo_path is derived only from the orchestrator cwd. If the cwd is not inside the repo the
  // user wants, they should change cwd and call create_worktree again.
  let repoPath: string;
  try {
    repoPath = await exec("git rev-parse --show-toplevel", orchestratorCwd, 5_000);
  } catch (error: unknown) {
    return {
      ok: false,
      streamId,
      message: `Could not resolve repo_path: orchestrator cwd ${orchestratorCwd} is not inside a git repo (${error instanceof Error ? error.message : String(error)}). Change cwd to a path inside the target repo, then call create_worktree again.`,
    };
  }

  // Discovery dry-run: surface bootstrap-config options for the repo WITHOUT creating a worktree,
  // regardless of whether a [flitterbot] config already exists.
  if (discovery) {
    const config = await readWorktreeConfig(repoPath);
    return {
      ok: true,
      streamId,
      message: await buildDiscoveryAdvisory(repoPath, config, "discovery"),
    };
  }

  let cleanupMessage = "";
  if (stream.worktree_path && existsSync(stream.worktree_path)) {
    if (!force) {
      return {
        ok: true,
        streamId,
        worktreePath: stream.worktree_path,
        message: `Stream '${stream.name}' already has a worktree at ${stream.worktree_path}. Call create_worktree with force=true to delink it and create a new one (old worktree left on disk for cleanup).`,
      };
    }
    cleanupMessage = `Old worktree delinked at ${stream.worktree_path} (left on disk). `;
  } else if (stream.worktree_path && stream.repo_path && stream.repo_path !== repoPath) {
    cleanupMessage = `Old worktree left at ${stream.worktree_path} (switched from ${stream.repo_path}). `;
  }

  // Read the [flitterbot] config once and reuse it for base-ref resolution + bootstrap.
  const config = await readWorktreeConfig(repoPath);

  // base_ref priority: explicit arg > flitterbot.baseRef config > orchestrator cwd's checked-out
  // HEAD > repo_path's checked-out HEAD. The cwd default is usually right (a worktree-based
  // orchestrator forks off its own worktree branch), but it's implicit, so we emit an advisory
  // whenever a checked-out HEAD is used so the user can pin a base via config if desired.
  let resolvedBaseRef: string;
  let baseRefNote = "";
  if (baseRef) {
    resolvedBaseRef = baseRef;
    baseRefNote = `\nBase: '${resolvedBaseRef}' (explicit base_ref).`;
  } else if (config.baseRef) {
    resolvedBaseRef = config.baseRef;
    baseRefNote = `\nBase: '${resolvedBaseRef}' (from flitterbot.baseRef config).`;
  } else {
    const cwdBranch = await tryHeadBranch(orchestratorCwd);
    const repoBranch = cwdBranch ? null : await tryHeadBranch(repoPath);
    const fallback = cwdBranch ?? repoBranch;
    if (!fallback) {
      return {
        ok: false,
        streamId,
        message: `Could not resolve a fork base: orchestrator cwd (${orchestratorCwd}) and repo (${repoPath}) have no checked-out branch (missing, not a repo, or detached HEAD). Pass base_ref explicitly or set git config flitterbot.baseRef.`,
      };
    }
    resolvedBaseRef = fallback;
    const source = cwdBranch ? "orchestrator cwd's checked-out HEAD" : "repo's checked-out HEAD";
    baseRefNote = `\nBase: '${resolvedBaseRef}' (default = ${source}; not configured). To pin the fork base from inside this repo/worktree, run: git config flitterbot.baseRef <branch-or-origin/branch>`;
  }

  const slug = slugify(stream.name);
  const nextNum = (await getHighestBranchNumber(repoPath)) + 1;
  const resolvedBranch = `${String(nextNum).padStart(3, "0")}-${slug}`;

  const SHA_RE = /^[0-9a-f]{7,40}$/i;
  if (SHA_RE.test(resolvedBaseRef)) {
    return {
      ok: false,
      streamId,
      message: `baseRef "${resolvedBaseRef}" looks like a commit SHA. Please provide a branch name (e.g. "main" or "origin/develop").`,
    };
  }
  try {
    const isTag = await exec(`git tag -l ${JSON.stringify(resolvedBaseRef)}`, repoPath, 5_000);
    if (isTag) {
      return {
        ok: false,
        streamId,
        message: `baseRef "${resolvedBaseRef}" is a tag, not a branch. Please provide a branch name.`,
      };
    }
  } catch {}
  try {
    await exec(`git rev-parse --verify ${JSON.stringify(resolvedBaseRef)}`, repoPath, 5_000);
  } catch {
    return {
      ok: false,
      streamId,
      message: `baseRef "${resolvedBaseRef}" does not resolve to a known branch. Check the name and try again.`,
    };
  }

  const normalizedBase = resolvedBaseRef.replace(/^origin\//, "");

  try {
    const worktrees = await exec("git worktree list --porcelain", repoPath, 10_000);
    if (worktrees.includes(`branch refs/heads/${resolvedBranch}`)) {
      const lines = worktrees.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === `branch refs/heads/${resolvedBranch}`) {
          for (let j = i; j >= 0; j--) {
            if (lines[j]!.startsWith("worktree ")) {
              const existingPath = lines[j]!.slice("worktree ".length);
              enrichStream(blackboard, streamId, repoPath, existingPath, normalizedBase);
              return {
                ok: true,
                streamId,
                worktreePath: existingPath,
                branchName: resolvedBranch,
                message: `${cleanupMessage}Worktree already exists at ${existingPath} on branch ${resolvedBranch}. Base branch recorded as ${normalizedBase}`,
              };
            }
          }
        }
      }
    }
  } catch {}

  try {
    const result = await createWorktree(repoPath, resolvedBranch, resolvedBaseRef);

    // Ensure the local tracking branch exists so close-stream can later `git checkout <base>`.
    if (normalizedBase !== "main") {
      try {
        await exec(`git rev-parse --verify ${JSON.stringify(normalizedBase)}`, repoPath, 5_000);
      } catch {
        try {
          await exec(
            `git branch ${JSON.stringify(normalizedBase)} ${JSON.stringify(`origin/${normalizedBase}`)}`,
            repoPath,
            10_000,
          );
        } catch {}
      }
    }
    enrichStream(blackboard, streamId, repoPath, result.worktreePath, normalizedBase);

    let bootstrapSummary = "";
    try {
      if (isConfigured(config)) {
        bootstrapSummary = await runBootstrap(repoPath, result.worktreePath, config);
      } else {
        // Unconfigured: skip all bootstrap and hand the agent a setup advisory so it can
        // persist a [flitterbot] recipe into .git/config for future creates.
        bootstrapSummary = `\n\n${await buildDiscoveryAdvisory(repoPath, config, "unconfigured")}`;
      }
    } catch (error: unknown) {
      bootstrapSummary = `\nBootstrap error: ${error instanceof Error ? error.message : String(error)}`;
    }

    return {
      ok: true,
      streamId,
      worktreePath: result.worktreePath,
      branchName: resolvedBranch,
      message: `${cleanupMessage}Worktree created at ${result.worktreePath} on branch ${resolvedBranch}${baseRefNote}${bootstrapSummary}`,
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      streamId,
      message: `${cleanupMessage}Failed to create worktree: ${msg}`,
    };
  }
}
