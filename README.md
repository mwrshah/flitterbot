# Flitterbot

Orchestration runtime for Claude Code. Routes WhatsApp/web messages to concurrent Pi agents that supervise Claude Code sessions in git worktrees.
<img width="1500" height="896" alt="image" src="https://github.com/user-attachments/assets/88ba376b-2688-4de5-8836-9910736a8dd6" />

Architecture: [`docs/overview.md`](docs/overview.md). Deep dives: [`docs/<feature>/FEATURE.md`](docs/).

## Prerequisites

Node.js 22+, pnpm, tmux, Claude Code CLI, sqlite3.

## Install

```bash
pnpm install && pnpm --dir web install
cp .env.example .env
node installer/install.mjs
~/.flitterbot/bin/flitterbot-up start
~/.flitterbot/bin/flitterbot-wa auth
pnpm --dir web dev
```

Step by step: copying `.env.example` gives you a file in which to set `GROQ_API_KEY`; `installer/install.mjs` deploys `~/.flitterbot/` and wires the hooks; the last two steps are optional — `flitterbot-wa auth` links WhatsApp, and `pnpm --dir web dev` starts the web UI on port 3188.

Installer flags: `--dry-run` preview, `--with-scheduler` launchd/systemd cron.

## Config

`.env`: `GROQ_API_KEY` required for classification. Model-provider credentials are configured from *Settings → Accounts & Model providers* in the Flitterbot web UI, or supplied through provider environment variables such as `ANTHROPIC_API_KEY`.

Runtime tuning: edit `~/.flitterbot/config.json` — keys are self-describing. The user-facing prompt knobs are:

- `defaultAgentFirstMessage` — first instruction queued when the default agent starts.
- `tmuxBootstrapMessage` — optional setup text included in a new stream's first prompt when tmux is enabled.
- `tmuxEnabled` — enable tmux sub-agent orchestration and delivery of `tmuxBootstrapMessage`. The message may remain populated while tmux is disabled.
- `extraSkillPaths` — additional skill directories loaded after bundled Flitterbot skills.
- `learningsNotePath` — Markdown document used by the bundled `learnings` skill.

Flitterbot uses `~/.agents` as its agent resource directory, loading global instructions, skills, extensions, prompts, and themes through the bundled Pi SDK. It additionally loads skills from `~/.claude/skills`, bundled `~/.flitterbot/skills`, then `extraSkillPaths`. The installer seeds the always-loaded memory index at `~/.flitterbot/data/MEMORY.md` without overwriting user edits; the full learnings document remains independently configured by `learningsNotePath`. Provider credentials, custom models, and the dynamic model catalog cache live at `~/.flitterbot/control-surface/agent`. Tasks are managed through Flitterbot's bundled task API at `~/.flitterbot/data/tasks`; local notes live under `~/.flitterbot/data/notes`.

## Commands

```bash
~/.flitterbot/bin/flitterbot-up   start | status | stop | restart
~/.flitterbot/bin/flitterbot-wa   start | status | stop | auth
pnpm --dir web dev
pnpm run control-surface
node ~/.flitterbot/uninstall.mjs [--meta]
```

`pnpm --dir web dev` starts the web UI, and `pnpm run control-surface` runs the control surface from source. The uninstaller removes hooks and the scheduler; adding `--meta` also removes `~/.flitterbot/` itself.

## Troubleshooting

- *`flitterbot-up start` fails* — check `~/.flitterbot/config.json`, `control-surface.log`; verify `node`/`claude`/`tmux`/`sqlite3` on PATH.
- *WhatsApp auth errors* — re-run `flitterbot-wa auth`.
- *Hooks not firing* — check `~/.claude/settings.json`, `~/.flitterbot/logs/hooks-errors.log`. Async, 15s timeout.
- *Runtime restarts after stop* — scheduler installed; run uninstaller.

## License

[MIT](LICENSE)
