# Autonoma

Long-running orchestration runtime for Claude Code. See [`features/overview.md`](features/overview.md) for architecture, design principles, and feature breakdown.

Run by **cloning the repo locally** — not yet packaged as a standalone app.

---

## Prerequisites

### Required

- **Node.js 22+**, **pnpm**, **tmux**, **Claude Code CLI** (`claude`), **sqlite3**

### Required for WhatsApp

- A working terminal session for manual auth via `autonoma-wa auth`

### Optional

- A modern browser for the web UI

Sanity check:

```bash
node -v && pnpm -v && tmux -V && claude --version && sqlite3 --version
```

---

## First-time setup

### 1) Clone and install

```bash
git clone <repo-url> && cd autonoma
pnpm install
pnpm --dir web install
```

### 2) Configure environment

```bash
cp .env.example .env
# Edit .env:
#   ANTHROPIC_API_KEY  — optional with Pi OAuth tokens (`pi auth login`)
#   GROQ_API_KEY       — required for message classification
```

### 3) Run the installer

Deploys runtime files to `~/.autonoma/`, bootstraps config, writes `web/.env` with the auth token, optionally prompts for WhatsApp phone number, initializes the blackboard, and installs Claude Code hooks into `~/.claude/settings.json`.

```bash
node .autonoma/install.mjs              # full install
node .autonoma/install.mjs --dry-run    # inspect changes first
node .autonoma/install.mjs --with-scheduler  # also install launchd/systemd scheduler
```

### 4) Review generated config

```bash
~/.autonoma/config.json          # controlSurfaceHost/Port/Token, piModel, claudeCliCommand, projectRoot/sourceRoot
~/.autonoma/whatsapp/config.json # pairingPhoneNumber, recipientJid
web/.env                         # VITE_AUTONOMA_BASE_URL, VITE_AUTONOMA_TOKEN (auto-generated, gitignored)
```

### 5) Authenticate WhatsApp (optional)

```bash
~/.autonoma/bin/autonoma-wa auth                # QR mode
~/.autonoma/bin/autonoma-wa auth --pairing-code  # pairing-code mode
```

Auth state stored at `~/.autonoma/whatsapp/auth/`.

---

## Starting and stopping

### Control surface

```bash
~/.autonoma/bin/autonoma-up start     # handles pid cleanup, retries, logging
~/.autonoma/bin/autonoma-up status
~/.autonoma/bin/autonoma-up stop      # POST /stop → marks Pi ended, stops WhatsApp, removes pid
~/.autonoma/bin/autonoma-up restart
```

### Web app (development)

```bash
pnpm --dir web dev    # http://127.0.0.1:3188
```

Not managed by `autonoma-up`.

### WhatsApp (usually auto-managed by control surface)

```bash
~/.autonoma/bin/autonoma-wa start | status | stop | auth
```

### Scheduler (deferred — not installed by default)

If installed with `--with-scheduler`, periodically runs `~/.autonoma/cron/autonoma-checkin.sh` — may restart the control surface if machine state is actionable and runtime is down. Deferred to post-v1; Pi is reactive (human messages + hook events) until orchestration logic matures.

### Full shutdown

`autonoma-up stop` is temporary — the scheduler may bring the runtime back.

To permanently disable (removes hooks + scheduler entries):

```bash
node ~/.autonoma/uninstall.mjs          # disable, remove hooks/scheduler
node ~/.autonoma/uninstall.mjs --meta   # also remove ~/.autonoma/ entirely
```

No dedicated "pause but keep installed" command yet — use `stop` for temporary, `uninstall` for permanent.

---

## Repo layout

### Runtime source

- `src/server.ts`, `src/runtime.ts` — HTTP server and runtime orchestrator
- `src/pi/**` — Pi agent lifecycle, turn queue, session state
- `src/routes/**` — one file per HTTP endpoint
- `src/classifier/**` — Groq-based message routing
- `src/blackboard/**` — SQLite layer
- `src/claude-sessions/**` — tmux / Claude integration
- `src/whatsapp/**` — WhatsApp daemon / CLI / IPC
- `src/contracts/**` — shared API and runtime contracts
- `src/custom-tools/**` — worktree, session, workstream tools
- `web/**` — browser client
- `features/**` — architecture and spec docs

### Installed runtime assets (`.autonoma/` → deployed to `~/.autonoma/`)

```
~/.autonoma/
  config.json, manifest.json, blackboard.db
  logs/          # control-surface.log, cron.log, install.log, whatsapp.log, hooks-errors.log
  bin/           # autonoma-up, autonoma-wa
  hooks/         # hook-post.mjs — Node.js dispatcher
  scripts/, cron/, control-surface/, whatsapp/
```

External files touched:

- `~/.claude/settings.json`
- `~/Library/LaunchAgents/com.autonoma.scheduler.plist` (macOS)
- `~/.config/systemd/user/autonoma-scheduler.{service,timer}` (Linux)

Changes tracked in `~/.autonoma/manifest.json`.

### Operational notes

- **`projectRoot` / `sourceRoot`** in config = this Autonoma checkout, **not** the working directory for Claude sessions.
- **Session tracking gated by `AUTONOMA_AGENT_MANAGED=1`** — only sessions with this env var are tracked. Set automatically by `launch_claude_code` tool; opt in manually with `AUTONOMA_AGENT_MANAGED=1 claude`.
- **Hooks are Node.js** (`.mjs`, `node:*` built-ins only). Claude Code invokes `node ~/.autonoma/hooks/hook-post.mjs <event-slug>` → reads JSON from stdin, enriches with `AUTONOMA_*` env vars, POSTs to control surface. Silently skips when control surface is down. Errors in `~/.autonoma/logs/hooks-errors.log`.

---

## Dev commands

```bash
pnpm run control-surface    # run control surface from source
pnpm run web:dev             # dev server
pnpm run web:build           # production build
```

## Audit commands

```bash
pnpm install                     # install tooling
pnpm run audit                   # all audits
pnpm run audit:ts                # TypeScript only
pnpm run audit:shell             # Shell only
```

---

## Troubleshooting

| Problem | Check |
|---|---|
| `autonoma-up start` fails | `~/.autonoma/config.json`, `~/.autonoma/logs/control-surface.log`, `node`/`claude`/`tmux`/`sqlite3` available, `pnpm install` done |
| WhatsApp auth errors | Re-run `~/.autonoma/bin/autonoma-wa auth` |
| Hooks not firing | `~/.claude/settings.json`, `~/.autonoma/hooks/hook-post.mjs`, `~/.autonoma/logs/hooks-errors.log` — hooks run async with 15s timeout; silently skip when control surface is down |
| Runtime keeps restarting after stop | Scheduler still installed — run `node ~/.autonoma/uninstall.mjs` |

---

## Quick start

```bash
pnpm install && pnpm --dir web install       # 1. dependencies
node .autonoma/install.mjs                    # 2. deploy runtime
~/.autonoma/bin/autonoma-up start             # 3. start control surface
~/.autonoma/bin/autonoma-wa auth              # 4. optional: WhatsApp
pnpm --dir web dev                            # 5. optional: web UI
```

Stop: `~/.autonoma/bin/autonoma-up stop`
Disable permanently: `node ~/.autonoma/uninstall.mjs`
