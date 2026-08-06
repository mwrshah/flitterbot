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

Step by step: copying `.env.example` gives you a file for model provider keys and the optional `GROQ_API_KEY`; `installer/install.mjs` deploys `~/.flitterbot/`, wires hooks for installed harnesses, and asks which harness to use by default. The last two steps are optional — `flitterbot-wa auth` links WhatsApp, and `pnpm --dir web dev` starts the web UI on port 3188.

Installer flags: `--dry-run` preview, `--with-scheduler` launchd/systemd cron.

## Get started

1. Open [http://127.0.0.1:3188](http://127.0.0.1:3188).
2. Select the settings cog in the top-right corner.
3. Sign in to OpenAI Codex or another OAuth model provider.
4. Open the first active stream, *flitterbot*.
5. Select a model in the message input.
6. Send your first message.

To use an API key, add the standard Pi environment variable to `.env`, such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Restart Flitterbot. When the model appears in the model selector, it is ready to use.

`GROQ_API_KEY` is optional. Set it if you want to use WhatsApp or the Surface at [http://127.0.0.1:3188/](http://127.0.0.1:3188/). Groq routes messages from these inputs to the correct stream. Direct messages at `/streams/<pi-session-id>` do not require Groq.

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
