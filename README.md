# Flitterbot

Orchestration runtime built on Pi. Routes WhatsApp/web messages to concurrent Pi agents that supervise Claude Code or Codex sessions in git worktrees. The bundled `/skill:tmux` skill launches and manages either harness.
<img width="1500" height="896" alt="image" src="https://github.com/user-attachments/assets/88ba376b-2688-4de5-8836-9910736a8dd6" />

Architecture: [`docs/overview.md`](docs/overview.md). Deep dives: [`docs/<feature>/FEATURE.md`](docs/).

## Prerequisites

Node.js 22+, pnpm, tmux, sqlite3, and at least one supported downstream harness: Claude Code CLI or Codex CLI.

## Install

```bash
pnpm install && pnpm --dir web install
cp .env.example .env
node installer/install.mjs
~/.flitterbot/bin/flitterbot-up start
~/.flitterbot/bin/flitterbot-wa auth
pnpm --dir web dev
```

Step by step: copying `.env.example` gives you a file in which to set `GROQ_API_KEY`; `installer/install.mjs` deploys `~/.flitterbot/`, wires hooks for installed harnesses, and asks which harness to use by default. The last two steps are optional — `flitterbot-wa auth` links WhatsApp, and `pnpm --dir web dev` starts the web UI on port 3188.

Installer flags: `--dry-run` preview, `--with-scheduler` launchd/systemd cron.

## Model login

`GROQ_API_KEY` in `.env` powers message classification. The Pi agents that run Flitterbot use separate model credentials. For API-key providers, set the standard provider environment variable, such as `ANTHROPIC_API_KEY`. For subscription or other OAuth providers, open *Settings → Accounts & Model providers* in the web UI. A ChatGPT Plus/Pro Codex subscription can run Flitterbot's default agent and work-stream orchestrators themselves.

Flitterbot does not expose Pi's interactive `/login` command. The web OAuth flow stores credentials in `~/.flitterbot/control-surface/agent/auth.json`; it does not rely on Pi CLI credentials in `~/.pi/agent/auth.json`. Claude Code and Codex downstream harnesses must also be authenticated in their own CLIs.

## Config

Edit `~/.flitterbot/config.json` for runtime configuration. Useful quick-start options include:

- `defaultAgentFirstMessage` — initial instruction queued for the default agent and new default streams.
- `tmuxBootstrapMessage` — optional tmux guidance included in a new work stream's initial context when tmux is enabled.
- `tmuxEnabled` — enable downstream tmux orchestration for work streams.
- `extraSkillPaths` — additional skill directories loaded after bundled Flitterbot skills.
- `learningsNotePath` — Markdown document used by the bundled `learnings` skill.
- `harness` — default downstream harness used by `/skill:tmux`: `claude` or `codex`.

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

- *`flitterbot-up start` fails* — check `~/.flitterbot/config.json`, `control-surface.log`; verify `node`, `tmux`, `sqlite3`, and the configured `claude` or `codex` harness on PATH.
- *WhatsApp auth errors* — re-run `flitterbot-wa auth`.
- *Hooks not firing* — check `~/.claude/settings.json` for Claude Code or `~/.codex/hooks.json` for Codex, then check `~/.flitterbot/logs/hooks-errors.log`. Async, 15s timeout.
- *Runtime restarts after stop* — scheduler installed; run uninstaller.

## License

[MIT](LICENSE)
