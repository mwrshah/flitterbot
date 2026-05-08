# Flitterbot

Orchestration runtime for Claude Code. Routes WhatsApp/web messages to concurrent Pi agents that supervise Claude Code sessions in git worktrees.

Architecture: [`docs/overview.md`](docs/overview.md). Deep dives: [`docs/<feature>/FEATURE.md`](docs/).

## Prerequisites

Node.js 22+, pnpm, tmux, Claude Code CLI, sqlite3.

## Install

```bash
pnpm install && pnpm --dir web install
cp .env.example .env                    # set GROQ_API_KEY
node installer/install.mjs              # deploys ~/.flitterbot/, wires hooks
~/.flitterbot/bin/flitterbot-up start
~/.flitterbot/bin/flitterbot-wa auth    # optional: WhatsApp
pnpm --dir web dev                      # optional: web UI (:3188)
```

Installer flags: `--dry-run` preview, `--with-scheduler` launchd/systemd cron.

## Config

`.env`: `GROQ_API_KEY` required (classifier); `ANTHROPIC_API_KEY` optional (falls back to Pi OAuth via `pi` → `/login`).

Runtime tuning: edit `~/.flitterbot/config.json` — keys are self-describing. The user-facing prompt knobs are:

- `defaultAgentFirstMessage` — first instruction queued when the default agent starts.
- `newStreamFirstMessageFooter` — footer appended to the first prompt sent to every new stream orchestrator.
- `tmux2Enabled` — include tmux2 sub-agent orchestration instructions in orchestrator prompts.
- `extraSkillPaths` — additional skill directories loaded after bundled Flitterbot skills.

Skills load from `~/.claude/skills`, `~/.agents/skills`, bundled `~/.flitterbot/skills`, then `extraSkillPaths`. Tasks are managed through Flitterbot's bundled task API; local notes live under `~/.flitterbot/notes`.

## Commands

```bash
~/.flitterbot/bin/flitterbot-up   start | status | stop | restart
~/.flitterbot/bin/flitterbot-wa   start | status | stop | auth
pnpm --dir web dev                          # web UI
pnpm run control-surface                    # run from source
node ~/.flitterbot/uninstall.mjs [--meta]   # remove hooks+scheduler (+~/.flitterbot/)
```

## Troubleshooting

- *`flitterbot-up start` fails* — check `~/.flitterbot/config.json`, `control-surface.log`; verify `node`/`claude`/`tmux`/`sqlite3` on PATH.
- *WhatsApp auth errors* — re-run `flitterbot-wa auth`.
- *Hooks not firing* — check `~/.claude/settings.json`, `~/.flitterbot/logs/hooks-errors.log`. Async, 15s timeout.
- *Runtime restarts after stop* — scheduler installed; run uninstaller.
