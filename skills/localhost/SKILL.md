---
name: localhost
description: Configure and run repository-local localhost services from any registered worktree. Installed at ~/.flitterbot/skills/localhost/SKILL.md.
argument-hint: "[setup|start|stop|status|list] [worktree] [--port service=port]"
---

# Localhost

Inspect a repository, define its localhost recipe in repository-local Git config, and run that recipe from a selected worktree's active code.

`<skill-dir-path>` is the path from the injected "References are relative to" line.

## Launcher

```bash
bash "<skill-dir-path>/scripts/worktree-up.sh" [worktree-number|name|main] [--port service=port]
bash "<skill-dir-path>/scripts/worktree-up.sh" --stop [worktree-number|name|main]
bash "<skill-dir-path>/scripts/worktree-up.sh" --status [worktree-number|name|main]
bash "<skill-dir-path>/scripts/worktree-up.sh" --list
bash "<skill-dir-path>/scripts/worktree-up.sh" --config
```

The script is the execution layer. Keep repository discovery and config authoring in this skill.

## Repository-local config

Read and write this contract with `git config --local`. It lives in the repository's shared `.git/config`, so every registered worktree sees it. Do not use `~/.flitterbot/config.json` for repository setup.

Existing Flitterbot worktree setup uses:

- `flitterbot.baseref` — branch used as the worktree creation base
- repeated `flitterbot.copypath` — files copied into a new worktree
- repeated `flitterbot.postcreate` — commands run after worktree creation

Localhost adds one repeated service list and a small subsection per service:

```bash
git config --local --add flitterbot.localhost.service backend
git config --local flitterbot.localhost.backend.dir api
git config --local flitterbot.localhost.backend.command 'uv run server.py --port {port}'
git config --local flitterbot.localhost.backend.port 8000
git config --local flitterbot.localhost.backend.op-env '<optional 1Password Environment ID>'
git config --local flitterbot.localhost.backend.scope worktree

git config --local --add flitterbot.localhost.service frontend
git config --local flitterbot.localhost.frontend.dir web
git config --local flitterbot.localhost.frontend.command 'pnpm exec vite --port {port}'
git config --local flitterbot.localhost.frontend.port 3000
git config --local --add flitterbot.localhost.frontend.env 'VITE_API_URL={service.backend.url}'
```

Per-service keys:

- `dir` and `command` are required.
- `port` is optional for watchers and other portless services. `{port}` inserts the resolved port; `PORT` is also exported.
- `op-env` is optional. When present, the service runs through that 1Password Environment.
- repeated `env` entries use `NAME=value`. Values may reference `{port}`, `{worktree}`, `{worktree.path}`, `{service.<name>.port}`, or `{service.<name>.url}`.
- `scope` defaults to `worktree`. Numbered worktrees receive `base port + worktree number`; unnumbered worktrees use a stable hash-derived slot. Set `scope` to `shared` only when the service cannot be isolated. Shared services use the configured canonical port and the selected worktree's code, so only one such instance can run at a time.

`--port service=port` overrides a service port for one launch. The chosen port is saved so status and stop use the same value.

## Setup workflow

$ARGUMENTS

### Routing

- For a direct start, stop, status, list, or config request, run the matching launcher command.
- For setup or a custom localhost objective, use the workflow as a toolkit and adapt it to the repository.

### 1. Inspect

Read `git config --local --get-regexp '^flitterbot\.'` first. Preserve `baseref`, `copypath`, and `postcreate`. Then inspect root/package manifests, backend manifests, frontend manifests, existing dev scripts, environment stubs, and current aliases or launch docs.

Identify each independently runnable service, its working directory, canonical command, canonical port, required cross-service URLs, and optional 1Password Environment ID. Prefer direct commands that accept one explicit `{port}` over package scripts that already hardcode a second port.

### 2. Choose isolation

Use `scope=worktree` when the process and its dependencies can coexist on distinct ports. Use `scope=shared` when a platform permits only one local instance or relies on a central backend that cannot be duplicated. State this tradeoff before changing config.

Portless background workers may be configured without `port`; they remain stoppable through tracked process ownership, but missing-state recovery requires a listening port.

### 3. Confirm and write

Show the proposed services and exact `git config --local` commands. Confirm ambiguous commands, shared scope, secrets environments, or URL wiring with the user. Then remove only superseded `flitterbot.localhost.*` keys and write the agreed contract. Leave unrelated Flitterbot and Git config untouched.

Validate with:

```bash
git config --local --get-regexp '^flitterbot\.(baseref|copypath|postcreate|localhost\.)'
bash "<skill-dir-path>/scripts/worktree-up.sh" --config
bash "<skill-dir-path>/scripts/worktree-up.sh" --status [worktree]
```

### 4. Launch safely

Run status before start. On a conflict, the launcher prints the listener PID, command, user, and working directory. Stop only when ownership resolves to the selected worktree. Missing or stale state falls back to configured listening ports, with user/worktree checks before the verified process tree is signaled.
