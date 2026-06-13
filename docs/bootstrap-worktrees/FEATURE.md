# Bootstrap Worktrees

Make freshly created stream worktrees runnable without manual setup by declaring a per-repo bootstrap recipe in the repo's local `.git/config`: copy gitignored env/secrets into the worktree, then run dependency-install/build hooks. When a repo has no recipe yet, surface a discovery advisory so the agent can author one.

## Problem

`create_worktree` produces an isolated git worktree, but a checkout alone is not runnable. Real repos need two things after `git worktree add`:

1. *Gitignored files copied in* — `.env`, `.env.local`, credentials, certs. These never travel with the worktree because they are gitignored.
2. *Dependencies installed per package* — and a single root install does not cover mixed-ecosystem monorepos. Sindri is pnpm at root plus a separate npm `agent-runner`; Klair is pnpm client plus `uv` api plus `uv` renewals-pipeline. One command in one dir cannot bootstrap these.

The previous implementation guessed: it auto-detected lockfiles (`pyproject.toml`→`uv sync`, `pnpm-lock.yaml`→`pnpm install`, `bun.lock*`→`bun install`) at root + one level, and copied `.env`/`.env.local` by filename up to depth 3. This silently missed npm subpackages (so Sindri's `tsx` was never installed), missed non-`.env` secrets like `credentials.json` and cert dirs, and had no way for a repo to declare anything explicit.

`gtr` already solves this for its own worktrees via custom `.git/config` sections (`[gtr] postCreate` hooks + `copy` includes). Flitterbot should own the same model as first-class primitives instead of guessing.

## Goals

- Read a bootstrap recipe from the repo's *local, uncommitted* `.git/config` under a `[flitterbot]` section. Local-only is deliberate: copy paths reference gitignored secrets and should stay per-clone, never committed.
- Three primitives: `flitterbot.copyPath` (files/dirs copied main→worktree), `flitterbot.postCreate` (ordered shell strings), `flitterbot.baseRef` (fork base override).
- Keep `create_worktree` zero-required: `stream_id` is ambient (injected from the orchestrator's bound stream), `repo_path` is derived strictly from the orchestrator cwd, and branch names auto-generate. The LLM never types ceremony it can't get wrong.
- Never silently mirror the orchestrator's checked-out HEAD without saying so: when the bare HEAD default is used as the fork base, print an advisory pointing at `flitterbot.baseRef`.
- Run copies *first*, then hooks — install/build steps must see the env files they need.
- Run hooks *sequentially in declared order* (install before build), *best-effort* — a failing hook never fails worktree creation; every result is reported in the tool message.
- When unconfigured, copy/install *nothing* and return a discovery advisory: discovered env files, classified package ecosystems, and ready-to-paste `git config --add` commands.
- A `discovery` dry-run flag runs the same scan without creating a worktree, regardless of whether the repo is already configured.
- Surface the active recipe read-only in the web downstream-sessions panel.

## Non-Goals

- Do not run a repo's own `bootstrap`/`setup` npm script. The recipe is explicit `copyPath`/`postCreate`; repo-specific orchestration (convex priming, 1Password env injection) rides on `postCreate` hooks, not a special primitive.
- Do not commit the recipe. No `.flitterbot.json` in the repo tree; `.git/config` is the single store.
- Do not auto-detect/auto-run install commands when unconfigured. That is a cutover — unconfigured means advisory, not silent heuristic. (The discovery scan reuses ecosystem detection only to *seed* the advisory.)
- Do not use `fff` for discovery. It honors `.gitignore` and cannot surface `.env` files (confirmed: no no-ignore option at instantiation, FFI, or query level), and `manager.ts` double-excludes `.env*`. Discovery must hit disk directly.
- Do not introduce symlink/linkPaths, git-town-style multi-branch topology, or dev-launcher config. `flitterbot.baseRef` is a single fork-base override, not a parent-branch graph. Out of scope.

## Primitives

All live in the repo's local `.git/config`:

```ini
[flitterbot]
	baseRef = main
	copyPath = klair-api/.env
	copyPath = klair-api/credentials.json
	copyPath = .scratch/certs
	postCreate = (cd klair-client && pnpm install)
	postCreate = (cd klair-api && uv sync)
```

- `flitterbot.copyPath` (multivar) — a file or directory copied from the main repo into the worktree at the same relative path. Recursive for dirs. Runs first. Path-escape guarded (must stay within repo→worktree).
- `flitterbot.postCreate` (multivar) — an arbitrary shell string executed with `cwd` = worktree root. Each command carries its own subdir entry, e.g. `(cd agent-runner && npm install)`. This is what makes mixed-ecosystem monorepos work: one hook per tool/dir, where a single root install cannot suffice.
- `flitterbot.baseRef` (single value) — the branch new worktrees fork from. Supports local branches (`main`) and remote-tracking refs (`origin/main`). Overrides the implicit HEAD-parse default. Optional.

Set them from inside the repo/worktree:

```bash
git config --add flitterbot.copyPath <relative/path>
git config --add flitterbot.postCreate '<shell command>'
git config flitterbot.baseRef <branch-or-origin/branch>
```

If running from another cwd, prefix the command with `git -C <repo>`.

## Tool Parameters

`create_worktree` takes *no required parameters* — `stream_id` is ambient (the tool is constructed bound to the orchestrator's stream and injected at execute time; the LLM never passes it), and `repo_path` is resolved from the orchestrator cwd. The common case is a zero-arg call.

Only three optional parameters are LLM-facing:

- `base_ref` — fork-base override, resolved by priority below. Use only for develop/release/stacked work when config/cwd should not decide.
- `force` — recreate when a worktree already exists. Without it, an existing worktree returns a safe "already exists" result.
- `discovery` — dry-run; returns the setup advisory, creates nothing.

Branch names always auto-generate as `NNN-<stream-slug>`. If the orchestrator cwd is not inside the target repo, the tool fails loudly; change cwd to the intended repo and call again.

### base_ref resolution

Priority, highest first:

1. explicit `base_ref` arg
2. `flitterbot.baseRef` from `.git/config`
3. orchestrator *cwd's* checked-out HEAD (`git rev-parse --abbrev-ref HEAD` in the orchestrator cwd)
4. `repo_path`'s checked-out HEAD (fallback when the cwd has none)

The cwd default (3) is the intended common case: a worktree-based orchestrator forks off *its own worktree branch*, not the main repo's baseline — branching from where you're actually working. (4) only kicks in when the cwd is missing/detached/not-a-repo. Both are *implicit* — mirroring whatever branch is checked out — so whenever (3) or (4) is used the result message prints an advisory naming the source and how to pin a base via `git config flitterbot.baseRef <branch-or-origin/branch>` from inside the repo/worktree. Cases (1) and (2) print a short confirming note. If neither cwd nor repo has a usable branch (both detached/missing), the tool fails loudly and asks for an explicit `base_ref` or config. This keeps the convenient default while removing the silent-mirror failure surface.

## Bootstrap Policy

- Copies run before hooks, unconditionally.
- Hooks run sequentially in declared order. Best-effort: each hook's stdout/stderr is captured into the result summary; a non-zero exit is reported but does not fail `create_worktree` (the worktree already exists successfully).
- Per-hook timeout is generous (5 min) to allow real installs/builds.
- Unconfigured repos are *not* failed and *not* heuristically installed. They return a discovery advisory and the worktree is created clean.

Guiding principle baked into the advisory: prefer package managers that keep a global/content-addressed cache (pnpm, bun, uv, poetry, pdm, cargo, go, maven, gradle, bundler, composer, yarn-berry) so each new worktree reuses the cache instead of refetching. Flag non-caching managers (npm, yarn-classic, pip, pipenv) and ask the user to migrate before configuring `postCreate`.

## Discovery

A single `find . -maxdepth 5` (heavy dirs pruned: `node_modules`, `.git`, `dist`, `build`, `.next`, `.venv`, `target`, `vendor`, etc.) collects, in one pass:

- *Env/secret files* — `.env*`, excluding committed templates (`.example`/`.sample`/`.template`/`.dist`). These are gitignored, so `fff` is structurally blind to them; the disk scan is the right tool.
- *Package-manager markers* — lockfiles + manifests, grouped by directory and resolved per-dir to one ecosystem in priority order (lockfiles disambiguate which tool owns a shared `pyproject.toml`/`yarn.lock`). Each is classified caching vs non-caching.

Discovery feeds the advisory only. It does not author config — the agent explores the repo + README and persists the recipe.

## Architecture

```
create_worktree (orchestrator tool)
        │  discovery=true ──────────────► readWorktreeConfig + buildDiscoveryAdvisory("discovery")
        │                                  → return advisory, NO worktree created
        ▼
git worktree add + enrichStream(base_branch)
        │
        ▼
readWorktreeConfig(repoPath)            ── git config --get-all flitterbot.copyPath / .postCreate
        │
   isConfigured? ──no──► buildDiscoveryAdvisory("unconfigured")   (find depth-5 scan → advisory)
        │ yes
        ▼
runBootstrap: runCopyPaths (first) → runPostCreate (sequential, best-effort)
        │
        ▼
result.message = worktree summary + (copy/hook results | advisory)

browser-pi-session-stream route ── readWorktreeConfig ──► StreamInfo.copyPaths / .postCreate
        │
        ▼
web downstream-sessions-panel: read-only "Bootstrap Config" block under worktree info
```

## Backend Design

### Config + discovery module

Create `src/streams/worktree-config.ts`. Pure-ish helpers plus git/`find` shell-outs.

```ts
export type WorktreeBootstrapConfig = { copyPaths: string[]; postCreate: string[] };

export function readWorktreeConfig(repoPath: string): Promise<WorktreeBootstrapConfig>;
export function isConfigured(config: WorktreeBootstrapConfig): boolean;

export type DiscoveredEcosystem = { dir: string; manager: string; cmd: string; caching: boolean };
export function discoverRepo(
  repoPath: string,
  maxDepth?: number,
): Promise<{ envFiles: string[]; ecosystems: DiscoveredEcosystem[] }>;

export function buildDiscoveryAdvisory(
  repoPath: string,
  config: WorktreeBootstrapConfig,
  mode: "unconfigured" | "discovery",
): Promise<string>;
```

- `readWorktreeConfig` runs `git config --get-all flitterbot.copyPath` / `.postCreate` (exit 1 = absent = empty, not error).
- `discoverRepo` shells one pruned `find -maxdepth 5`, splits results into env files (template-filtered) and per-dir marker sets, resolves each dir to an ecosystem.
- Ecosystem resolution priority order: pnpm, bun, uv, poetry, pdm, cargo, go, maven, gradle, bundler, composer (caching); yarn-berry (`.yarnrc.yml`+`yarn.lock`) caching; npm, yarn-classic, pip, pipenv (non-caching); bare `pyproject.toml` → suggest uv.
- `buildDiscoveryAdvisory` shared by both unconfigured-auto and explicit discovery; the discovery variant also echoes current config.

### create_worktree integration

`src/custom-tools/create-worktree.ts`:

- Remove the old `INSTALL_RULES`/`installDependencies`/`findEnvFiles`/`copyEnvFiles` heuristics.
- Add `discovery = false` param. When true, short-circuit before any git work: read config, return `buildDiscoveryAdvisory(..., "discovery")`, create nothing.
- After `enrichStream`, run bootstrap: if `isConfigured`, `runCopyPaths` (first) then `runPostCreate` (sequential, best-effort), append results to message. Else append `buildDiscoveryAdvisory(..., "unconfigured")`.
- `runCopyPaths` uses `cpSync(recursive)` with path-escape + existence guards.

### Tool schema

`src/runtime.ts`: add a `discovery` boolean property to the `create_worktree` schema, destructure it, pass through to `executeCreateWorktree`. Extend the tool description to document the `[flitterbot]` recipe and the unconfigured advisory.

### Stream info route

`src/routes/browser-pi-session-stream.ts`: read `readWorktreeConfig(ws.repo_path)` and add `copyPaths` + `postCreate` to the JSON response.

## Frontend Design

- `web/src/server/streams.ts`: extend `StreamInfo` with `copyPaths: string[]` and `postCreate: string[]`.
- `web/src/components/downstream-sessions-panel.tsx`: under the existing "Active Worktree" block, render a read-only "Bootstrap Config" section listing `copyPaths` and `postCreate` (mono, truncated). Shown only when either list is non-empty.

## Files

- `docs/bootstrap-worktrees/FEATURE.md` (create) — this document.
- `src/streams/worktree-config.ts` (create) — config reader (`copyPath`/`postCreate`/`baseRef`), depth-5 discovery scan, ecosystem classification, advisory builder.
- `src/custom-tools/create-worktree.ts` (modify) — config-driven bootstrap; `discovery` dry-run; repo resolved from orchestrator cwd only; `base_ref` priority chain with HEAD-default advisory.
- `src/runtime.ts` (modify) — remove `stream_id`, `repo_path`, branch/update repair params from `create_worktree` schema; expose only optional `base_ref`, `force`, `discovery`; empty `required`; updated tool description.
- `src/routes/browser-pi-session-stream.ts` (modify) — surface `copyPaths`/`postCreate`/`configuredBaseRef` in stream info.
- `web/src/server/streams.ts` (modify) — extend `StreamInfo`.
- `web/src/components/downstream-sessions-panel.tsx` (modify) — render Bootstrap Config block.

## Test Plan

Config reader:

- Absent `[flitterbot]` section → `{ copyPaths: [], postCreate: [] }`, `isConfigured` false.
- Multivar `copyPath`/`postCreate` returned in order; `isConfigured` true.

Discovery:

- Env templates (`.env.example`/`.sample`/`.template`) excluded; real `.env*` included.
- Mixed monorepo classifies per-dir: caching (pnpm/uv) vs non-caching (npm) correctly flagged. (Verified against Sindri: `agent-runner` → npm(noncache); Klair: per-subdir uv/pnpm/pip.)
- Depth-5 reaches nested packages; pruned dirs excluded; runs in well under the find timeout.

Bootstrap:

- Configured: copies run before hooks; recursive dir copy; path-escape rejected; hook results captured; failing hook does not fail creation.
- Unconfigured: nothing copied/installed; advisory returned; worktree still created.
- `discovery: true`: no worktree created; advisory returned whether or not configured; current config echoed.

Frontend:

- Panel shows copyPaths/postCreate when present; hidden when both empty.

Typecheck (server + web), biome, and the existing `create-worktree.test.ts` pass.

## Acceptance Criteria

- A repo with a `[flitterbot]` recipe gets gitignored secrets copied and per-package deps installed on worktree creation, including mixed-ecosystem monorepos.
- A failing hook reports but never fails worktree creation; copies always precede hooks.
- An unconfigured repo creates a clean worktree and returns a discovery advisory with concrete `git config --add` commands and caching-vs-non-caching ecosystem classification.
- `discovery: true` surfaces setup options without creating a worktree, regardless of current config.
- The web panel shows the active bootstrap recipe read-only.
- No lockfile-heuristic auto-install remains; `.git/config` is the single source of the recipe.
