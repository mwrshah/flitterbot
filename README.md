# Autonoma

Long-running orchestration runtime for Claude Code. Architecture and design in [`features/overview.md`](features/overview.md).

## Quick start

```bash
pnpm install && pnpm --dir web install       # 1. dependencies
cp .env.example .env                          # 2. configure (see below)
node .autonoma/install.mjs                    # 3. deploy runtime
~/.autonoma/bin/autonoma-up start             # 4. start control surface
~/.autonoma/bin/autonoma-wa auth              # 5. optional: WhatsApp
pnpm --dir web dev                            # 6. optional: web UI
```

Stop: `~/.autonoma/bin/autonoma-up stop` — Disable permanently: `node ~/.autonoma/uninstall.mjs`

**Prerequisites:** Node.js 22+, pnpm, tmux, Claude Code CLI (`claude`), sqlite3

## Configuration

The installer (step 3 in quickstart) deploys to `~/.autonoma/`, writes `web/.env` (from repo root), initializes the blackboard, and registers Claude Code hooks. Use `--dry-run` to inspect changes or `--with-scheduler` to also install a launchd/systemd scheduler.

**`.env`:** `ANTHROPIC_API_KEY` (optional - otherwise fallbacks to Anthropic Oauth token obtained via Pi TUI — Run `pi` in terminal, then `/login` to populate), `GROQ_API_KEY` (required for message classification).

**`~/.autonoma/config.json` options:**
- `piModel` (default `claude-opus-4-6`) — model for all Pi agents
- `piThinkingLevel` (default `medium`) — `off` / `minimal` / `low` / `medium` / `high` / `xhigh`
- `stallMinutes` (default `15`) — inactivity before a session is stalled
- `toolTimeoutMinutes` (default `4`) — tool-waiting timeout before stall
- `claudeCliCommand` (default `claude --dangerously-skip-permissions`) — CLI used to launch sessions
- `projectsDir` (default `~/development`) — working directory for Pi agents and default root for Claude Code sessions (overridden by worktree path once created)
- `wipeStreamsOnStart` (default `false`) — close all open streams on startup
- `whatsappEnabled` (default `true`) — enable/disable WhatsApp channel

**WhatsApp auth:** `~/.autonoma/bin/autonoma-wa auth` (QR) or `--pairing-code`. Auth state at `~/.autonoma/whatsapp/auth/`.

## Commands

```bash
~/.autonoma/bin/autonoma-up start | status | stop | restart
~/.autonoma/bin/autonoma-wa start | status | stop | auth
pnpm --dir web dev                            # http://127.0.0.1:3188
node ~/.autonoma/uninstall.mjs                # remove hooks + scheduler
node ~/.autonoma/uninstall.mjs --meta         # also remove ~/.autonoma/
pnpm run control-surface                      # run from source
pnpm run audit | audit:ts | audit:shell
```

If `--with-scheduler` was used, `autonoma-up stop` is still permanent — the scheduler only POSTs a tick to an already-running runtime and cannot start a stopped one. To remove the scheduler itself, run the uninstaller.

## Repo layout

`src/server.ts`, `src/runtime.ts` — HTTP server and runtime orchestrator. `src/pi/**` — Pi agent lifecycle, turn queue, session state. `src/routes/**` — one file per HTTP endpoint. `src/classifier/**` — Groq-based message routing. `src/blackboard/**` — SQLite layer. `src/claude-sessions/**` — tmux / Claude integration. `src/whatsapp/**` — WhatsApp daemon / CLI / IPC. `src/contracts/**` — shared API and runtime contracts. `src/custom-tools/**` — worktree, session, workstream tools. `web/**` — browser client. `features/**` — architecture and spec docs.

Installed runtime (`~/.autonoma/`): `config.json`, `blackboard.db`, `logs/`, `bin/`, `hooks/`, `scripts/`, `cron/`, `whatsapp/`.

`projectRoot` / `sourceRoot` = this checkout, not the working directory for Claude sessions. Only sessions with `AUTONOMA_AGENT_MANAGED=1` are tracked — set automatically by `launch_claude_code`, or manually with `AUTONOMA_AGENT_MANAGED=1 claude`. Hook errors log to `~/.autonoma/logs/hooks-errors.log`; silently skip when control surface is down.

## Troubleshooting

**`autonoma-up start` fails** — check `~/.autonoma/config.json`, `control-surface.log`, and that `node`/`claude`/`tmux`/`sqlite3` are in PATH and `pnpm install` has run.
**WhatsApp auth errors** — re-run `autonoma-wa auth`.
**Hooks not firing** — check `~/.claude/settings.json`, `hook-post.mjs`, `hooks-errors.log`; hooks run async with a 15s timeout.
**Runtime restarts after stop** — scheduler still installed; run `node ~/.autonoma/uninstall.mjs`.
