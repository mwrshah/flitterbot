# Feature: Installer / Uninstaller

Permission-gated, manifest-tracked deployment of `~/.autonoma/` and modification of external configs. Every change reversible in one command.

## Problem

Autonoma modifies files it doesn't own (`~/.claude/settings.json`, scheduler units) and deploys a runtime tree to `~/.autonoma/`. Changes must coexist with existing config and be removable without artifacts.

## Architecture

Two standalone ESM scripts — `install.mjs` and `uninstall.mjs` — using only `node:*` built-ins (no dependencies). Both log to `~/.autonoma/logs/install.log` with 10 MB rotation.

### Installer flow (`node .autonoma/install.mjs`)

1. **Preflight** — detect OS, locate project root (via sibling `features/`+`src/` dirs or `~/.autonoma/source-root`), create directory skeleton, write VERSION
2. **Deploy runtime files** — copy from repo `.autonoma/` into `~/.autonoma/`, removing obsolete legacy files (shell hooks, Python dispatch scripts). Tracks create/update/remove changes, shows diff, requires confirmation
3. **Bootstrap config** — merge defaults into `~/.autonoma/config.json` (control surface, pi model, blackboard path, WhatsApp paths, `claudeCliCommand`, `projectsDir`). Prompts interactively for `projectsDir` if missing. Syncs `VITE_AUTONOMA_BASE_URL` and `VITE_AUTONOMA_TOKEN` to `web/.env`
4. **Bootstrap WhatsApp config** — if `~/.autonoma/whatsapp/config.json` absent, prompts for pairing phone number, writes `recipientJid`, `pairingPhoneNumber`, `typingDelayMs`
5. **Init blackboard** — runs `scripts/init-db.sh` to create/migrate SQLite DB at configured `blackboardPath`
6. **Install hooks** — registers hook groups in `~/.claude/settings.json` for `SessionStart`, `Stop`, `SessionEnd` pointing to `node ~/.autonoma/hooks/hook-post.mjs <event-slug>`. Cleans deprecated events (`PreToolUse`, `PostToolUse`, etc.) from previous installs
7. **Install scheduler** (opt-in `--with-scheduler`) — macOS: launchd plist; Linux: systemd user service+timer. Cleans legacy crontab entries during Linux install

Each step shows a diff and requires explicit confirmation before writing.

### Uninstaller flow (`node ~/.autonoma/uninstall.mjs`)

1. **Remove hooks** — surgical removal of entries matching `~/.autonoma/hooks/` prefix from `settings.json`. Drift detection via manifest checksum comparison
2. **Remove scheduler** — macOS: bootout + delete plist; Linux: disable/stop systemd units + remove files; legacy crontab cleanup
3. **Cleanup manifest** — delete if no external targets remain
4. **Remove runtime tree** — graceful stop via `autonoma-up stop`, then `rm -rf ~/.autonoma/`

`--external-only` skips step 4 (preserves `~/.autonoma/`).

### Manifest (`~/.autonoma/manifest.json`)

Target-keyed structure tracking all external modifications:

```json
{
  "version": "1",
  "autonoma_version": "<VERSION>",
  "installed_at": "<ISO>",
  "targets": {
    "<path>": {
      "type": "<json-merge | file-create | owned-tree>",
      "modifications": [{ "id": "...", "action": "...", "content_sha256": "..." }],
      "checksums": { "algorithm": "sha256", "file_before_install": "...", "file_after_install": "..." }
    }
  }
}
```

Checksums enable drift detection — uninstaller warns if `settings.json` changed externally since install.

### Hook dispatcher (`hooks/hook-post.mjs`)

Reads Claude Code hook payload from stdin, enriches with `AUTONOMA_*` env vars (agent-managed metadata, tmux session, workstream ID), POSTs to control surface at `http://{host}:{port}/hook/{event-slug}`. 2-second timeout; silently skips if control surface is down (`ECONNREFUSED`).

## CLI

**Installer** (`node .autonoma/install.mjs`):
- `--dry-run` — show changes without writing
- `--yes` — skip confirmation prompts
- `--with-scheduler` — install scheduler entries (off by default)

**Uninstaller** (`node ~/.autonoma/uninstall.mjs`):
- `--dry-run` — show changes without writing
- `--yes` — skip confirmation prompts
- `--external-only` — remove hooks/scheduler but preserve `~/.autonoma/`

## Runtime tree (`~/.autonoma/`)

| Directory | Contents |
|-----------|----------|
| (root) | `install.mjs`, `uninstall.mjs`, `VERSION`, `config.json`, `manifest.json`, `source-root` |
| `hooks/` | `hook-post.mjs` |
| `scripts/` | `init-db.sh`, `runtime-common.sh` |
| `bin/` | `autonoma-up`, `autonoma-wa` |
| `cron/` | `autonoma-checkin.sh`, `scheduler.sh`, `com.autonoma.scheduler.plist` |
| `whatsapp/` | `cli.js`, `daemon.js`, `run-entry.js`, `config.json`, `config.json.example`, `README.md` |
| `src/blackboard/` | `schema.sql` |
| `logs/` | `install.log`, `hooks-errors.log` |

## External files touched

- `~/.claude/settings.json` — hook entries
- `~/Library/LaunchAgents/com.autonoma.scheduler.plist` (macOS) or `~/.config/systemd/user/autonoma-scheduler.{service,timer}` (Linux)
- `web/.env` — frontend auth tokens

## Key files

| File | Role |
|------|------|
| `.autonoma/install.mjs` | Installer — runtime deployment, config bootstrap, hooks, scheduler |
| `.autonoma/uninstall.mjs` | Uninstaller — surgical removal via manifest |
| `.autonoma/hooks/hook-post.mjs` | Hook dispatcher — enriches + POSTs events to control surface |
| `.autonoma/scripts/init-db.sh` | Blackboard DB creation + migration (versioned schema, legacy upgrade path) |

## Principles

- **Uninstaller-first**: removal code before installation code
- **Idempotent**: double-install doesn't duplicate; double-uninstall doesn't error
- **Permission-gated**: every modification requires explicit confirmation
- **Manifest-tracked**: all external changes recorded with checksums for drift detection
- **Zero dependencies**: both scripts use only `node:*` built-ins

## Observations

- **attention!** `syncWebEnv()` (`install.mjs:572-591`) writes `web/.env` without calling `confirm()` — shows the diff but skips the confirmation prompt. Every other external write is permission-gated; this one isn't.
- **attention!** The uninstaller has no awareness of `web/.env`. The installer writes it (`VITE_AUTONOMA_BASE_URL`, `VITE_AUTONOMA_TOKEN`), but `uninstall.mjs` never cleans it up — not even with `--meta`. It's also absent from the manifest, so drift detection doesn't cover it.
- **TBD!** `install.mjs:527` silently upgrades `piModel` from `claude-sonnet-4-6` to `claude-opus-4-6` on every install. This is a one-time migration baked into the installer as a permanent conditional — should be removed once all installs have rotated past it, or guarded by a version check.
