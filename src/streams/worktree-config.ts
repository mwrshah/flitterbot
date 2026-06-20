import { exec as cpExec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execPromise = promisify(cpExec);

export type WorktreeBootstrapConfig = {
  copyPaths: string[];
  postCreate: string[];
  // Single value: the branch new worktrees fork from. Overrides the HEAD-parse default.
  baseRef: string | null;
};

// Bootstrap recipe lives in the repo's local .git/config (uncommitted, per-clone) under a
// `[flitterbot]` section as multivars, mirroring how gtr stores its hooks:
//   [flitterbot]
//     copyPath = klair-api/.env
//     copyPath = .scratch/certs
//     postCreate = (cd klair-client && pnpm install)
//     postCreate = (cd klair-api && uv sync)
async function getAll(repoPath: string, key: string): Promise<string[]> {
  try {
    const { stdout } = await execPromise(`git config --get-all ${key}`, {
      cwd: repoPath,
      timeout: 5_000,
    });
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    // git config exits 1 when the key is absent — that's "unconfigured", not an error.
    return [];
  }
}

async function getOne(repoPath: string, key: string): Promise<string | null> {
  const all = await getAll(repoPath, key);
  return all[0] ?? null;
}

export async function readWorktreeConfig(repoPath: string): Promise<WorktreeBootstrapConfig> {
  const [copyPaths, postCreate, baseRef] = await Promise.all([
    getAll(repoPath, "flitterbot.copyPath"),
    getAll(repoPath, "flitterbot.postCreate"),
    getOne(repoPath, "flitterbot.baseRef"),
  ]);
  return { copyPaths, postCreate, baseRef };
}

export async function resolveGitRoot(cwd: string | null | undefined): Promise<string | null> {
  if (!cwd) return null;
  try {
    const { stdout } = await execPromise("git rev-parse --show-toplevel", {
      cwd,
      timeout: 5_000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function resolveMainRepoPath(cwd: string | null | undefined): Promise<string | null> {
  if (!cwd) return null;
  try {
    const { stdout } = await execPromise("git rev-parse --path-format=absolute --git-common-dir", {
      cwd,
      timeout: 5_000,
    });
    const commonGitDir = stdout.trim();
    if (!commonGitDir) return null;
    return path.dirname(commonGitDir);
  } catch {
    return null;
  }
}

export async function resolveBootstrapConfigSource(
  cwd: string | null | undefined,
  worktreePath: string | null | undefined,
): Promise<string | null> {
  const cwdGitRoot = await resolveGitRoot(cwd);
  if (cwdGitRoot) return cwdGitRoot;
  return resolveMainRepoPath(worktreePath);
}

export function isConfigured(config: WorktreeBootstrapConfig): boolean {
  return config.copyPaths.length > 0 || config.postCreate.length > 0;
}

// ---- Discovery helpers (seed the advisory shown when a repo is unconfigured / discovery mode) ----

// Committed templates we never want to copy as secrets.
const ENV_TEMPLATE = /\.(example|sample|template|dist)$/i;

// Heavy dirs pruned from the scan so depth-5 `find` stays fast and noise-free.
const PRUNE_DIRS = [
  "node_modules",
  ".git",
  "__pycache__",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "target",
  "vendor",
  ".gradle",
];

// Package managers that keep a global/content-addressed cache, so installing in each new worktree
// reuses already-fetched packages instead of refetching from the network. Resolved per-dir in
// priority order — lockfiles disambiguate which tool actually owns a pyproject.toml/yarn.lock.
const CACHING_RULES: Array<{ marker: string; manager: string; cmd: string }> = [
  { marker: "pnpm-lock.yaml", manager: "pnpm", cmd: "pnpm install" },
  { marker: "bun.lock", manager: "bun", cmd: "bun install" },
  { marker: "bun.lockb", manager: "bun", cmd: "bun install" },
  { marker: "uv.lock", manager: "uv", cmd: "uv sync" },
  { marker: "poetry.lock", manager: "poetry", cmd: "poetry install" },
  { marker: "pdm.lock", manager: "pdm", cmd: "pdm install" },
  { marker: "Cargo.toml", manager: "cargo", cmd: "cargo fetch" },
  { marker: "go.mod", manager: "go", cmd: "go mod download" },
  { marker: "pom.xml", manager: "maven", cmd: "mvn -q dependency:go-offline" },
  { marker: "build.gradle", manager: "gradle", cmd: "./gradlew dependencies" },
  { marker: "build.gradle.kts", manager: "gradle", cmd: "./gradlew dependencies" },
  { marker: "Gemfile.lock", manager: "bundler", cmd: "bundle install" },
  { marker: "composer.lock", manager: "composer", cmd: "composer install" },
];

// yarn is split: berry (.yarnrc.yml, PnP/global cache) caches, classic (.yarn-only lockfile) refetches.
const YARN_BERRY = { manager: "yarn (berry)", cmd: "yarn install" };

// Managers without a reusable cross-worktree cache — flag so the agent asks the user to migrate.
const NONCACHING_RULES: Array<{ marker: string; manager: string }> = [
  { marker: "package-lock.json", manager: "npm" },
  { marker: "yarn.lock", manager: "yarn (classic)" },
  { marker: "requirements.txt", manager: "pip" },
  { marker: "Pipfile", manager: "pipenv" },
];

// pyproject.toml with no companion lockfile — ambiguous tool, default-suggest uv but note it.
const BARE_PYPROJECT = { manager: "python (no lockfile)", cmd: "uv sync" };

const ALL_MARKERS = [
  ".yarnrc.yml",
  "pyproject.toml",
  ...CACHING_RULES.map((r) => r.marker),
  ...NONCACHING_RULES.map((r) => r.marker),
];

export type DiscoveredEcosystem = {
  dir: string; // relative to repo root, "" for root
  manager: string;
  cmd: string;
  caching: boolean;
};

// Single fast scan: shell out to `find` (depth-capped, heavy dirs pruned) instead of recursively
// readdir-walking in JS. One pass collects every env file + package-manager marker, then we group.
async function findPaths(repoPath: string, maxDepth: number): Promise<string[]> {
  const prune = PRUNE_DIRS.map((d) => `-name ${d}`).join(" -o ");
  const names = [".env*", ...ALL_MARKERS].map((n) => `-name ${JSON.stringify(n)}`).join(" -o ");
  const cmd = `find . -maxdepth ${maxDepth} \\( ${prune} \\) -prune -o -type f \\( ${names} \\) -print`;
  try {
    const { stdout } = await execPromise(cmd, {
      cwd: repoPath,
      timeout: 10_000,
      maxBuffer: 4 << 20,
    });
    return stdout
      .split("\n")
      .map((l) => l.trim().replace(/^\.\//, ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function resolveEcosystem(dir: string, markers: Set<string>): DiscoveredEcosystem | null {
  for (const r of CACHING_RULES) {
    if (markers.has(r.marker)) return { dir, manager: r.manager, cmd: r.cmd, caching: true };
  }
  if (markers.has(".yarnrc.yml") && markers.has("yarn.lock")) {
    return { dir, ...YARN_BERRY, caching: true };
  }
  for (const r of NONCACHING_RULES) {
    if (markers.has(r.marker)) return { dir, manager: r.manager, cmd: "", caching: false };
  }
  if (markers.has("pyproject.toml")) {
    return { dir, ...BARE_PYPROJECT, caching: true };
  }
  return null;
}

export async function discoverRepo(
  repoPath: string,
  maxDepth = 5,
): Promise<{ envFiles: string[]; ecosystems: DiscoveredEcosystem[] }> {
  const paths = await findPaths(repoPath, maxDepth);
  const envFiles: string[] = [];
  const markersByDir = new Map<string, Set<string>>();

  for (const rel of paths) {
    const base = path.basename(rel);
    const dir = path.dirname(rel) === "." ? "" : path.dirname(rel);
    if (base.startsWith(".env")) {
      if (!ENV_TEMPLATE.test(base)) envFiles.push(rel);
      continue;
    }
    let set = markersByDir.get(dir);
    if (!set) {
      set = new Set();
      markersByDir.set(dir, set);
    }
    set.add(base);
  }

  const ecosystems: DiscoveredEcosystem[] = [];
  for (const [dir, markers] of markersByDir) {
    const eco = resolveEcosystem(dir, markers);
    if (eco) ecosystems.push(eco);
  }
  envFiles.sort();
  ecosystems.sort((a, b) => a.dir.localeCompare(b.dir));
  return { envFiles, ecosystems };
}

// Build the human/LLM-facing advisory: explains the two knobs, optionally shows the current
// config, dumps what was discovered, and hands the agent ready-to-run `git config` commands so it
// can persist a bootstrap recipe into .git/config. Used both for the unconfigured auto-path and
// the explicit discovery dry-run.
export async function buildDiscoveryAdvisory(
  repoPath: string,
  config: WorktreeBootstrapConfig,
  mode: "unconfigured" | "discovery",
): Promise<string> {
  const { envFiles, ecosystems } = await discoverRepo(repoPath);
  const caching = ecosystems.filter((e) => e.caching);
  const nonCaching = ecosystems.filter((e) => !e.caching);

  const lines: string[] = [];
  if (mode === "discovery") {
    lines.push(
      `🔍 Discovery dry-run for ${repoPath} — NO worktree was created.`,
      "",
      isConfigured(config) || config.baseRef
        ? `Current [flitterbot] config:\n  baseRef: ${config.baseRef ?? "(none — defaults to checked-out HEAD)"}\n  copyPath: ${config.copyPaths.join(", ") || "(none)"}\n  postCreate: ${config.postCreate.join(", ") || "(none)"}`
        : "Current [flitterbot] config: NONE.",
      "",
    );
  } else {
    lines.push(
      "⚠ No [flitterbot] worktree bootstrap config found in this repo's .git/config. The worktree was created, but NO deps were installed and NO files were copied.",
      "",
    );
  }
  lines.push(
    "Flitterbot bootstraps worktrees from two multivars in the repo's LOCAL .git/config (uncommitted, per-clone):",
    "  • flitterbot.copyPath  — files OR dirs copied from the main repo into the worktree (e.g. gitignored .env / secrets / certs). Copies run FIRST.",
    "  • flitterbot.postCreate — arbitrary ordered shell strings run with cwd = worktree root, AFTER copies. Each command carries its own subdir entry, e.g. (cd some-api && uv sync).",
    "",
    "Set them from inside this repo/worktree (repeat --add per multivar value):",
    "  git config --add flitterbot.copyPath <relative/path>",
    "  git config --add flitterbot.postCreate '<shell command>'",
    "",
    "Optionally pin the branch new worktrees fork from (otherwise the orchestrator's checked-out HEAD is used; origin/<branch> refs are supported):",
    "  git config flitterbot.baseRef <branch-or-origin/branch>",
    "",
    `If running from another cwd, prefix with: git -C ${JSON.stringify(repoPath)}`,
    "",
    "Bootstrap principles:",
    "  • Prefer package managers that cache deps globally (pnpm, bun, uv, poetry, pdm, cargo, go, maven, gradle, bundler, composer, yarn-berry) so each new worktree reuses the cache instead of refetching from the network.",
    "  • For workspace monorepos a single root install usually covers all packages; for MIXED-ecosystem monorepos add one postCreate per subdir/tool.",
    "  • Copy every gitignored env/secret the app needs to run (.env, .env.local, credentials, certs).",
    "  • If a package dir only has a non-caching manager (npm/yarn-classic/pip), stop and ask the user to adopt a caching one (pnpm/uv/bun) before configuring postCreate.",
    "",
  );

  if (envFiles.length > 0) {
    lines.push("Discovered env/secret files (candidates for copyPath):");
    for (const f of envFiles) lines.push(`  • ${f}`);
  } else {
    lines.push("Discovered env/secret files: none (still check the README for required secrets).");
  }
  lines.push("");

  if (caching.length > 0) {
    lines.push("Discovered caching package ecosystems (candidates for postCreate):");
    for (const e of caching) {
      const where = e.dir === "" ? "/" : e.dir;
      lines.push(
        `  • ${e.manager} at ${where} → ${e.dir === "" ? e.cmd : `(cd ${e.dir} && ${e.cmd})`}`,
      );
    }
    lines.push("");
  }
  if (nonCaching.length > 0) {
    lines.push(
      "⚠ Non-caching ecosystems found (will refetch every worktree — ask user to migrate):",
    );
    for (const e of nonCaching) {
      const where = e.dir === "" ? "/" : e.dir;
      lines.push(`  • ${e.manager} at ${where}`);
    }
    lines.push("");
  }
  if (caching.length === 0 && nonCaching.length === 0) {
    lines.push("Discovered package ecosystems: none.");
    lines.push("");
  }

  lines.push(
    "Next step for the agent: explore the repo + README/package scripts to validate whether the env files above are complete and which postCreate hooks are appropriate. Then suggest concrete baseRef/copyPath/postCreate options to the user and ask what configuration they want persisted before creating the worktree.",
  );
  return lines.join("\n");
}
