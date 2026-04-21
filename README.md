# Flitterbot

Long-running orchestration runtime for Claude Code. Architecture and design in [`docs/overview.md`](docs/overview.md).

## Quick start
```bash
    # 1. dependencies
pnpm install && pnpm --dir web install
    # 2. configure (see below)
cp .env.example .env
    # 3. deploy runtime
node installer/install.mjs
    # 4. start control surface
~/.flitterbot/bin/flitterbot-up start
    # 5. optional: WhatsApp
~/.flitterbot/bin/flitterbot-wa auth
    # 6. optional: web UI
pnpm --dir web dev
```

Stop: `~/.flitterbot/bin/flitterbot-up stop` — Disable permanently: `node ~/.flitterbot/uninstall.mjs`

**Prerequisites:** Node.js 22+, pnpm, tmux, Claude Code CLI (`claude`), sqlite3

## Configuration

The installer (step 3 in quickstart) deploys to `~/.flitterbot/`, writes `web/.env` (from repo root), initializes the blackboard, and registers Claude Code hooks. Use `--dry-run` to inspect changes or `--with-scheduler` to also install a launchd/systemd scheduler.

**`.env`:** `ANTHROPIC_API_KEY` (optional - otherwise fallbacks to Anthropic Oauth token obtained via Pi TUI — Run `pi` in terminal, then `/login` to populate), `GROQ_API_KEY` (required for message classification).

**`~/.flitterbot/config.json` options:**
- `piModel` (default `claude-opus-4-7`) — model for all Pi agents
- `piThinkingLevel` (default `high`) — `off` / `minimal` / `low` / `medium` / `high` / `xhigh`
- `stallMinutes` (default `15`) — inactivity before a session is stalled
- `toolTimeoutMinutes` (default `4`) — tool-waiting timeout before stall
- `claudeCliCommand` (default `claude --dangerously-skip-permissions`) — CLI used to launch sessions
- `projectsDir` (default `~/development`) — working directory for Pi agents and default root for Claude Code sessions (overridden by worktree path once created)
- `wipeStreamsOnStart` (default `false`) — close all open streams on startup
- `whatsappEnabled` (default `true`) — enable/disable WhatsApp channel
- `extraSkillPaths` (default `[]`) — extra directories to load skills from, in addition to the built-in `~/.agents/skills/` and `~/.claude/skills/`. Paths are expanded (`~` → home), resolved to absolute, and loaded in declared order. Missing directories are skipped with a warn log. Built-ins take precedence on name collisions — extras cannot shadow them; collisions are logged. Example: `"extraSkillPaths": ["~/work/team-skills", "/opt/shared/skills"]`

**WhatsApp auth:** `~/.flitterbot/bin/flitterbot-wa auth` (QR) or `--pairing-code`. Auth state at `~/.flitterbot/whatsapp/auth/`.

## Commands

```bash
~/.flitterbot/bin/flitterbot-up start | status | stop | restart
~/.flitterbot/bin/flitterbot-wa start | status | stop | auth

# http://127.0.0.1:3188
pnpm --dir web dev

# remove hooks + scheduler
node ~/.flitterbot/uninstall.mjs

# also remove ~/.flitterbot/
node ~/.flitterbot/uninstall.mjs --meta

# run from source
pnpm run control-surface

pnpm run audit | audit:ts | audit:shell
```

If `--with-scheduler` was used, `flitterbot-up stop` is still permanent — the scheduler only POSTs a tick to an already-running runtime and cannot start a stopped one. To remove the scheduler itself, run the uninstaller.

## Repo layout

`src/server.ts`, `src/runtime.ts` — HTTP server and runtime orchestrator. `src/pi/**` — Pi agent lifecycle, turn queue, session state. `src/routes/**` — one file per HTTP endpoint. `src/classifier/**` — Groq-based message routing. `src/blackboard/**` — SQLite layer. `src/claude-sessions/**` — tmux / Claude integration. `src/whatsapp/**` — WhatsApp daemon / CLI / IPC. `src/contracts/**` — shared API and runtime contracts. `src/custom-tools/**` — worktree, session, workstream tools. `web/**` — browser client. `docs/**` — architecture and spec docs.

Installed runtime (`~/.flitterbot/`): `config.json`, `blackboard.db`, `logs/`, `bin/`, `hooks/`, `scripts/`, `scheduler/`, `whatsapp/`.

`projectRoot` / `sourceRoot` = this checkout, not the working directory for Claude sessions. Only sessions with `FLITTERBOT_AGENT_MANAGED=1` are tracked — set automatically by `launch_claude_code`, or manually with `FLITTERBOT_AGENT_MANAGED=1 claude`. Hook errors log to `~/.flitterbot/logs/hooks-errors.log`; silently skip when control surface is down.

## Troubleshooting

**`flitterbot-up start` fails** — check `~/.flitterbot/config.json`, `control-surface.log`, and that `node`/`claude`/`tmux`/`sqlite3` are in PATH and `pnpm install` has run.
**WhatsApp auth errors** — re-run `flitterbot-wa auth`.
**Hooks not firing** — check `~/.claude/settings.json`, `hook-post.mjs`, `hooks-errors.log`; hooks run async with a 15s timeout.
**Runtime restarts after stop** — scheduler still installed; run `node ~/.flitterbot/uninstall.mjs`.

## TODO / Not Yet Implemented

- Cleanup cron for stale worktrees — old worktrees from force-recreated or repo-switched streams are left on disk and need periodic cleanup
