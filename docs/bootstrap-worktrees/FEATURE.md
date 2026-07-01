# Bootstrap Worktrees

Make stream worktrees runnable by declaring a per-repo bootstrap recipe in the repo's local `.git/config`: copy gitignored env/secrets into the worktree, then run dependency-install/build hooks.

## Tool

Agents use one stream-bound tool:

```ts
set_up_worktree({
  mode: "inspect" | "apply",
  path?: string,
  base_ref?: string,
  force?: boolean,
})
```

`stream_id` and `repo_path` are ambient. The tool is bound to the current stream, resolves the repo from the orchestrator cwd, and anchors new worktrees on the repo's main worktree.

## Modes

### `mode: "inspect"`

Inspect accepts no other arguments and never mutates. It reports:

- resolved repo path
- current stream `worktree_path` and recorded `base_branch`
- current `[flitterbot]` config
- resolved create base
- planned branch/path for a new worktree
- discovery advisory when config is missing

If no `[flitterbot]` config exists, inspect is intentionally verbose and returns action instructions: explore the repo, use discovery candidates to propose `copyPath`/`postCreate`, ask the user for the desired recipe and `baseRef`, persist the chosen `.git/config`, then retry apply.

### `mode: "apply"`

Apply mutates only after `[flitterbot]` bootstrap config exists. If config is missing, it refuses, prints the same action instructions plus discovery output, and creates nothing.

Rules:

- `set_up_worktree({ mode: "apply" })` creates a new worktree. If the stream already has a live worktree, it refuses.
- `set_up_worktree({ mode: "apply", force: true })` delinks the current stream association and mints a fresh worktree. The old worktree is left on disk.
- `set_up_worktree({ mode: "apply", base_ref: "main" })` creates from `main` when no worktree exists; when a worktree already exists, it updates only the recorded merge target. It never rebases, resets, checks out, or moves the branch.
- `set_up_worktree({ mode: "apply", path: "/existing/worktree", base_ref: "main" })` validates and attaches an existing worktree, recording `main` as the merge target.
- `path` without `base_ref` is rejected so attach always has an explicit close target.
- `force` with `path` is rejected: `force` means fresh create, `path` means attach existing.

## Config

All config lives in the repo's local, uncommitted `.git/config`:

```ini
[flitterbot]
	baseRef = main
	copyPath = .env
	copyPath = web/.env
	postCreate = pnpm install
	postCreate = (cd web && pnpm install)
```

- `flitterbot.baseRef` — default branch new worktrees fork from. Supports local branches and remote-tracking refs like `origin/main`.
- `flitterbot.copyPath` — multivar file/dir paths copied from main repo into the worktree before hooks.
- `flitterbot.postCreate` — multivar shell commands run in order with cwd = worktree root after copies.

Set from inside the repo/worktree:

```bash
git config flitterbot.baseRef main
git config --add flitterbot.copyPath .env
git config --add flitterbot.postCreate 'pnpm install'
```

## Base resolution

Create resolves the base by priority:

1. explicit `base_ref`
2. `flitterbot.baseRef`
3. orchestrator cwd's checked-out branch
4. repo main worktree's checked-out branch

SHAs and tags are rejected; provide a branch name.

## Bootstrap policy

- Copies run before hooks.
- Hooks run sequentially and best-effort; failures are reported but the already-created worktree remains.
- Unconfigured repos are not bootstrapped and apply refuses. Inspect provides the discovery advisory.
- Discovery scans disk directly because env files are often gitignored.

## Files

- `src/custom-tools/set-up-worktree.ts` — tool implementation.
- `src/streams/worktree-config.ts` — config reader and discovery advisory.
- `src/runtime.ts` — tool schema and `worktree_changed` broadcast.
- `src/streams/worktree-link.ts` — validation for attaching existing worktrees.
