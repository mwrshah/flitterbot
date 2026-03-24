# Installer Feature Audit

Comparison of `features/installer/FEATURE.md` against the actual implementation in `.autonoma/`.

---

## Matches

These claims in FEATURE.md are confirmed by the implementation:

- **Two standalone ESM scripts** — `install.mjs` (1188 lines) and `uninstall.mjs` (622 lines) using only `node:*` built-ins
- **Install log rotation** — logs to `~/.autonoma/logs/install.log` with 10 MB rotation
- **Preflight** — detects OS, locates project root (via `features/`+`src/` siblings or `source-root` file), creates directory skeleton, writes VERSION
- **Deploy runtime files** — copies from repo `.autonoma/` to `~/.autonoma/`, removes obsolete legacy files, tracks create/update/remove changes, shows diff, requires confirmation
- **Bootstrap config** — merges defaults into `config.json` including control surface, pi model, blackboard path, WhatsApp paths, `claudeCliCommand`, `projectsDir`. Prompts interactively for `projectsDir` if missing. Syncs `VITE_AUTONOMA_BASE_URL` and `VITE_AUTONOMA_TOKEN` to `web/.env`
- **Bootstrap WhatsApp config** — prompts for pairing phone number, writes `recipientJid`, `pairingPhoneNumber`, `typingDelayMs` if config absent
- **Init blackboard** — runs `scripts/init-db.sh` to create/migrate SQLite DB
- **Install hooks** — registers `SessionStart`, `Stop`, `SessionEnd` in `~/.claude/settings.json` pointing to `node ~/.autonoma/hooks/hook-post.mjs <event-slug>`. Cleans deprecated events (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop`)
- **Install scheduler** — opt-in via `--with-scheduler`; macOS: launchd plist; Linux: systemd user service+timer. Linux install cleans legacy crontab entries
- **Confirmation gates** — each step shows diff and requires explicit confirmation
- **Uninstaller hooks removal** — surgical removal of entries matching `~/.autonoma/hooks/` prefix; drift detection via manifest checksum
- **Uninstaller scheduler removal** — macOS: bootout + delete plist; Linux: disable/stop + remove files; legacy crontab cleanup
- **Manifest structure** — target-keyed with `version`, `autonoma_version`, `installed_at`, `targets` containing `type`, `modifications`, `checksums`. Types include `json-merge`, `file-create`, `owned-tree`
- **Hook dispatcher** — reads stdin payload, enriches with `AUTONOMA_*` env vars, POSTs to `http://{host}:{port}/hook/{event-slug}`. 2-second timeout; silently skips on `ECONNREFUSED`
- **CLI flags** — install: `--dry-run`, `--yes`, `--with-scheduler`. Uninstall: `--dry-run`, `--yes`, `--external-only`
- **Runtime tree layout** — all directories and files listed in the table are present in the deployment manifest
- **External files touched** — `~/.claude/settings.json`, systemd/launchd scheduler files, `web/.env`
- **Principles** — idempotent, permission-gated, manifest-tracked, zero-dependency behavior all confirmed in code

---

## Divergences

Where the doc and implementation disagree:

1. **Installer CLI has `--without-scheduler`** — The doc only lists `--dry-run`, `--yes`, `--with-scheduler`. The implementation also accepts `--without-scheduler` (alias `--skip-scheduler`) to explicitly disable scheduler installation.

2. **Uninstaller CLI has `--meta`** — The doc only lists `--dry-run`, `--yes`, `--external-only`. The implementation also accepts `--meta` which enables runtime tree removal. The `--external-only` flag's description matches the doc behavior, but `--meta` is an additional undocumented flag.

3. **Uninstaller has a web/.env cleanup step** — The doc lists 4 uninstaller steps (hooks → scheduler → manifest cleanup → runtime tree). The implementation has 5 steps: hooks → **web/.env cleanup** → scheduler → manifest cleanup → runtime tree.

4. **Uninstaller step 4 says "graceful stop via `autonoma-up stop`"** — The implementation does reference `autonoma-up` for graceful stop within `uninstallRuntimeTree()`, but the script path used is `join(AUTONOMA_DIR, "bin", "autonoma-up")` and it's part of runtime tree removal, not a standalone step.

---

## Missing from Doc

Implementation details not captured in FEATURE.md:

1. **Config defaults beyond what's listed** — The doc mentions control surface, pi model, blackboard path, WhatsApp paths, `claudeCliCommand`, `projectsDir`. The implementation also bootstraps: `piThinkingLevel` ("low"), `stallMinutes` (15), `toolTimeoutMinutes` (60), `wipeWorkstreamsOnStart` (false), `controlSurfaceHost` ("127.0.0.1"), `controlSurfacePort` (18820), auto-generated `controlSurfaceToken` (UUID), `whatsappEnabled`, `whatsappAuthDir`, `whatsappSocketPath`, `whatsappPidPath`, and more.

2. **`autonoma-up` process manager** — Listed in the runtime tree table as a bin file but not described. It's a substantial script (~438 lines) managing control surface lifecycle: start/stop/restart/status commands, PID tracking, lock-based concurrency protection, health checks, retry with exponential backoff, graceful→SIGTERM→SIGKILL shutdown cascade, and log rotation.

3. **`control-surface/` runtime directory** — Not listed in the runtime tree table. Created at runtime containing `server.pid`, `start.lock`, `last-start.json`.

4. **`autonoma-wa` script** — Listed in the bin table but not described anywhere.

5. **`runtime-common.sh`** — Listed in the runtime tree table but not described. Contains shared bash utilities (~191 lines).

6. **`autonoma-checkin.sh` behavior** — Listed in the cron directory but its actual behavior (reads config via Node.js, POSTs to `/cron/tick`) is not described.

7. **`scheduler.sh`** — Listed in the runtime tree but not described.

8. **File permission modes** — The implementation applies specific modes: 0o755 for executables, 0o644 for data files, 0o600 for secrets (config.json, manifest.json, whatsapp config). Not documented.

9. **Atomic file writes** — The implementation uses temp file + rename for safe writes. Not explicitly documented (implied by principles).

10. **`web/.env` as an external target** — Listed under "External files touched" but not mentioned in the uninstaller flow description.

---

## Missing from Implementation

Doc claims not found in the code:

1. **No gaps identified** — All features described in the doc are implemented. The doc is conservative; the implementation is a superset.
