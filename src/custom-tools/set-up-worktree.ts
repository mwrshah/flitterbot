import { exec as cpExec } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { BlackboardDatabase } from "../blackboard/db.ts";
import { enrichStream, getStreamById } from "../blackboard/query-streams.ts";
import type { StreamRow } from "../contracts/index.ts";
import {
  buildDiscoveryAdvisory,
  isConfigured,
  readWorktreeConfig,
  type WorktreeBootstrapConfig,
} from "../streams/worktree-config.ts";
import { checkWorktreeLink } from "../streams/worktree-link.ts";

const execPromise = promisify(cpExec);

type SetUpWorktreeMode = "inspect" | "apply";

type SetUpWorktreeResult = {
  ok: boolean;
  streamId: string;
  worktreePath?: string;
  branchName?: string;
  message: string;
};

const UNCONFIGURED_WORKTREE_AGENT_INSTRUCTIONS = [
  "Action needed before setting up a worktree:",
  "1. First explore the repo context to suggest candidates for post-create hooks. Use the discovery output below as a starting point: env/secret files are candidates for flitterbot.copyPath, and package ecosystems are candidates for flitterbot.postCreate.",
  "2. Suggest options to the user. Say which env files were turned up, which post-create hooks look appropriate, and ask the user what their decision is on the worktree configuration.",
  "3. Ask the user what the baseRef should be.",
  "4. Persist the user's chosen recipe with git config flitterbot.baseRef and repeated git config --add flitterbot.copyPath/postCreate, then retry set_up_worktree with mode:apply.",
].join("\n");

const NON_GIT_WORKTREE_AGENT_INSTRUCTIONS = [
  "Action needed before setting up a worktree:",
  "1. This cwd is not inside a git repo, so first identify the intended repository or ask the user which repo/cwd to use.",
  "2. Retry set_up_worktree from inside the intended git repository.",
].join("\n");

// ponytail: share the git exec helper with close-stream instead of carrying another shell-string wrapper.
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

async function resolveMainWorktreePath(repoPath: string): Promise<string> {
  const output = await exec("git worktree list --porcelain", repoPath, 10_000);
  const firstWorktree = output
    .split("\n")
    .find((line) => line.startsWith("worktree "))
    ?.slice("worktree ".length)
    .trim();
  return firstWorktree || repoPath;
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

async function resolveBaseRef(
  repoPath: string,
  orchestratorCwd: string,
  config: WorktreeBootstrapConfig,
  baseRef?: string,
): Promise<
  | { ok: true; resolvedBaseRef: string; normalizedBase: string; note: string }
  | { ok: false; message: string }
> {
  let resolvedBaseRef: string;
  let note = "";
  if (baseRef) {
    resolvedBaseRef = baseRef;
    note = `\nBase: '${resolvedBaseRef}' (explicit base_ref).`;
  } else if (config.baseRef) {
    resolvedBaseRef = config.baseRef;
    note = `\nBase: '${resolvedBaseRef}' (from flitterbot.baseRef config).`;
  } else {
    const cwdBranch = await tryHeadBranch(orchestratorCwd);
    const repoBranch = cwdBranch ? null : await tryHeadBranch(repoPath);
    const fallback = cwdBranch ?? repoBranch;
    if (!fallback) {
      return {
        ok: false,
        message: `Could not resolve a fork base: orchestrator cwd (${orchestratorCwd}) and repo (${repoPath}) have no checked-out branch (missing, not a repo, or detached HEAD). Pass base_ref explicitly or set git config flitterbot.baseRef.`,
      };
    }
    resolvedBaseRef = fallback;
    const source = cwdBranch ? "orchestrator cwd's checked-out HEAD" : "repo's checked-out HEAD";
    note = `\nBase: '${resolvedBaseRef}' (default = ${source}; not configured). To pin the fork base from inside this repo/worktree, run: git config flitterbot.baseRef <branch-or-origin/branch>`;
  }

  const SHA_RE = /^[0-9a-f]{7,40}$/i;
  if (SHA_RE.test(resolvedBaseRef)) {
    return {
      ok: false,
      message: `baseRef "${resolvedBaseRef}" looks like a commit SHA. Please provide a branch name (e.g. "main" or "origin/develop").`,
    };
  }
  try {
    const isTag = await exec(`git tag -l ${JSON.stringify(resolvedBaseRef)}`, repoPath, 5_000);
    if (isTag)
      return {
        ok: false,
        message: `baseRef "${resolvedBaseRef}" is a tag, not a branch. Please provide a branch name.`,
      };
  } catch {}
  try {
    await exec(`git rev-parse --verify ${JSON.stringify(resolvedBaseRef)}`, repoPath, 5_000);
  } catch {
    return {
      ok: false,
      message: `baseRef "${resolvedBaseRef}" does not resolve to a known branch. Check the name and try again.`,
    };
  }

  return {
    ok: true,
    resolvedBaseRef,
    normalizedBase: resolvedBaseRef.replace(/^origin\//, ""),
    note,
  };
}

async function buildInspectMessage(
  repoPath: string,
  stream: StreamRow,
  config: WorktreeBootstrapConfig,
  orchestratorCwd: string,
): Promise<string> {
  const configLines = [
    `Inspect: set_up_worktree`,
    `Repo: ${repoPath}`,
    `Stream worktree: ${stream.worktree_path ?? "none"}`,
    `Recorded base_ref: ${stream.base_branch ?? "none"}`,
    `Configured baseRef: ${config.baseRef ?? "none"}`,
    `copyPath: ${config.copyPaths.join(", ") || "none"}`,
    `postCreate: ${config.postCreate.join("; ") || "none"}`,
  ];

  const base = await resolveBaseRef(repoPath, orchestratorCwd, config);
  if (base.ok) configLines.push(`Resolved create base_ref: ${base.normalizedBase}`);

  if (isConfigured(config)) {
    const slug = slugify(stream.name);
    const nextNum = (await getHighestBranchNumber(repoPath)) + 1;
    const branch = `${String(nextNum).padStart(3, "0")}-${slug}`;
    const worktreePath = path.resolve(
      repoPath,
      "..",
      `${path.basename(repoPath)}-worktrees`,
      branch,
    );
    configLines.push(
      `Apply with no path would ${stream.worktree_path && existsSync(stream.worktree_path) ? "refuse because the stream already has a worktree" : "create a new worktree"}.`,
      `Planned branch: ${branch}`,
      `Planned path: ${worktreePath}`,
    );
    return configLines.join("\n");
  }

  return [
    ...configLines,
    "",
    "No [flitterbot] worktree bootstrap config found. No worktree can be applied until config exists.",
    UNCONFIGURED_WORKTREE_AGENT_INSTRUCTIONS,
    await buildDiscoveryAdvisory(repoPath, config, "discovery"),
  ].join("\n\n");
}

export async function executeSetUpWorktree(
  blackboard: BlackboardDatabase,
  streamId: string,
  orchestratorCwd: string,
  mode: SetUpWorktreeMode,
  baseRef?: string,
  force = false,
  targetPath?: string,
): Promise<SetUpWorktreeResult> {
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

  // Resolve the current worktree from cwd, then anchor created worktrees on the repo's main
  // worktree so launching from an existing linked worktree does not nest another -worktrees dir.
  let currentWorktreePath: string;
  let repoPath: string;
  try {
    currentWorktreePath = await exec("git rev-parse --show-toplevel", orchestratorCwd, 5_000);
    repoPath = await resolveMainWorktreePath(currentWorktreePath);
  } catch (error: unknown) {
    return {
      ok: false,
      streamId,
      message: [
        `Could not resolve repo_path: orchestrator cwd ${orchestratorCwd} is not inside a git repo (${error instanceof Error ? error.message : String(error)}). NO worktree was created.`,
        NON_GIT_WORKTREE_AGENT_INSTRUCTIONS,
      ].join("\n\n"),
    };
  }

  if (mode !== "inspect" && mode !== "apply") {
    return { ok: false, streamId, message: `mode is required and must be "inspect" or "apply".` };
  }

  const config = await readWorktreeConfig(repoPath);

  if (mode === "inspect") {
    if (baseRef || force || targetPath) {
      return {
        ok: false,
        streamId,
        message: `set_up_worktree inspect does not accept path/base_ref/force. Run set_up_worktree with mode:"inspect" only.`,
      };
    }
    return {
      ok: true,
      streamId,
      worktreePath: stream.worktree_path ?? undefined,
      message: await buildInspectMessage(repoPath, stream, config, orchestratorCwd),
    };
  }

  if (!isConfigured(config)) {
    return {
      ok: false,
      streamId,
      message: [
        "No [flitterbot] worktree bootstrap config found in this repo's .git/config. No changes made.",
        UNCONFIGURED_WORKTREE_AGENT_INSTRUCTIONS,
        await buildDiscoveryAdvisory(repoPath, config, "discovery"),
      ].join("\n\n"),
    };
  }

  if (force && targetPath) {
    return {
      ok: false,
      streamId,
      message: `force:true means mint a fresh worktree; path means attach an existing worktree. Pass one or the other, not both.`,
    };
  }

  if (targetPath && !baseRef) {
    return {
      ok: false,
      streamId,
      message: `Attaching an existing worktree requires base_ref so the stream's merge target is explicit. No changes made.`,
    };
  }

  const base = await resolveBaseRef(repoPath, orchestratorCwd, config, baseRef);
  if (!base.ok) return { ok: false, streamId, message: base.message };
  const { resolvedBaseRef, normalizedBase, note: baseRefNote } = base;

  if (targetPath) {
    const attachPath = path.resolve(orchestratorCwd, targetPath);
    if (stream.worktree_path && existsSync(stream.worktree_path)) {
      const current = path.resolve(stream.worktree_path);
      if (current !== attachPath) {
        return {
          ok: false,
          streamId,
          message: `Stream '${stream.name}' already has a worktree at ${stream.worktree_path}. Refusing to replace it with ${attachPath}.`,
        };
      }
    }
    const check = checkWorktreeLink(attachPath, repoPath);
    if (!check.ok)
      return {
        ok: false,
        streamId,
        message: `Cannot attach worktree ${attachPath}: ${check.reason}. No changes made.`,
      };
    enrichStream(blackboard, streamId, repoPath, attachPath, normalizedBase);
    return {
      ok: true,
      streamId,
      worktreePath: attachPath,
      branchName: check.branch,
      message: `Attached worktree ${attachPath} on branch ${check.branch}. Base branch recorded as ${normalizedBase}.`,
    };
  }

  let cleanupMessage = "";
  if (stream.worktree_path && existsSync(stream.worktree_path)) {
    if (baseRef && !force) {
      enrichStream(blackboard, streamId, repoPath, stream.worktree_path, normalizedBase);
      return {
        ok: true,
        streamId,
        worktreePath: stream.worktree_path,
        message: `Updated stream '${stream.name}' base branch to ${normalizedBase}. Worktree checkout was not changed.`,
      };
    }
    if (!force) {
      return {
        ok: false,
        streamId,
        worktreePath: stream.worktree_path,
        message: `Stream '${stream.name}' already has a worktree at ${stream.worktree_path}. No changes made. Pass force:true to mint a fresh worktree, or pass base_ref to update only the recorded merge target.`,
      };
    }
    cleanupMessage = `Old worktree delinked at ${stream.worktree_path} (left on disk). `;
  } else if (stream.worktree_path && stream.repo_path && stream.repo_path !== repoPath) {
    cleanupMessage = `Old worktree left at ${stream.worktree_path} (switched from ${stream.repo_path}). `;
  }

  const slug = slugify(stream.name);
  const nextNum = (await getHighestBranchNumber(repoPath)) + 1;
  const resolvedBranch = `${String(nextNum).padStart(3, "0")}-${slug}`;

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
      bootstrapSummary = await runBootstrap(repoPath, result.worktreePath, config);
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
