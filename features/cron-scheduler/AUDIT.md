# Cron Scheduler — FEATURE.md Audit

Audited 2026-03-24 against current `main` (58182b8).

## Matches

The following doc claims are verified accurate against the implementation:

- **Three-tier architecture** — OS timer fires bash script, bash script POSTs to `/cron/tick`, endpoint runs gate sequence. All three tiers implemented as described.
- **Bash script** (`autonoma-checkin.sh`) — reads token/host/port from `~/.autonoma/config.json` using Node.js (not jq), POSTs to `/cron/tick` with bearer auth, fails silently (`curl -sf ... || true`). No logic, no SQLite.
- **systemd timer** — `OnUnitActiveSec=10m`, `OnBootSec=2m`, service is `Type=oneshot`. Rendered in `install.mjs`.
- **macOS launchd** — `StartInterval=600` (10min). Template in `com.autonoma.scheduler.plist`.
- **Gate sequence** — all 6 gates implemented in `cron-tick.ts` in the documented order: (1) Pi busy, (2) Pi session exists, (3) WhatsApp connected, (4) active circuit breakers, (5) stale sessions, (6) no working sessions.
- **Response shape** — `CronTickResponse` type matches doc exactly: `{ok, action, reason, flags?}`. All reason values match.
- **`health_flags` table** — schema matches doc (flag PK, reason, set_at, expires_at, cleared_at). Created in migration v7.
- **Health flag functions** — `setHealthFlag`, `getActiveHealthFlags`, `clearHealthFlag`, `clearAllHealthFlags` all exist in `query-health-flags.ts` with documented signatures.
- **Cleared on startup** — `clearAllHealthFlags(this.blackboard)` called in `runtime.start()` (line 159).
- **Stale detection defaults** — `stallMinutes: 15`, `toolTimeoutMinutes: 60` confirmed in `load-config.ts`.
- **Stale detection logic** — `markStaleSessions()` uses both `stallMinutes` and `toolTimeoutMinutes` conditions as documented (event age AND tool age).
- **Cron reads stale, doesn't mark** — `cron-tick.ts` calls `getStaleSessions()` (read-only), not `markStaleSessions()`. Maintenance loop is the sole writer. Matches resolved observation.
- **Prompt content** — stale prompt lists session IDs and last activity; idle prompt asks Pi to review state, transcripts, Obsidian/Todoist context. Both match doc.
- **Cron messages skip router** — `resolveTargetSession()` (runtime.ts:598-601) returns default session for `source === "cron"`. In `message.ts`, router classification only runs for `web`/`whatsapp` sources.
- **Cron messages enter default Pi TurnQueue** — confirmed via `resolveTargetSession` routing and `runtime.enqueue`.
- **`source: "cron"`** — `MessageSource` type includes `"cron"`. Queue items carry source through.
- **Maintenance loop** — 60s `setInterval` in `runtime.ts`, independent of cron. Pings blackboard, refreshes WhatsApp, marks stale sessions, cleans 24h-old idle sessions (kills tmux), checks stuck turns.
- **Stuck-turn escalation** — sets `stuck_turn` health flag (30min TTL) and sends WhatsApp alert. Matches resolved observation.
- **Key Files table** — all listed files exist at documented paths.
- **`/cron/tick` route registration** — `server.ts` imports and routes to `handleCronTickRoute`.

## Divergences

- **Gate 2 mechanism** — Doc says "if session ended/crashed, skip". Implementation checks `!defaultPi.session` which tests whether the `AgentSession` JS object is truthy, not the `pi_sessions` DB status. The gate works because a crashed/ended session would have its object cleared, but the mechanism differs from what the doc implies.
- **Gate 1 null safety** — `getDefault()` returns `ManagedPiSession | undefined`, but `cron-tick.ts:38` accesses `defaultPi.state.getSnapshot()` without a null check. If Pi hasn't initialized yet, this would throw a runtime error (caught by server.ts error handler, returning 500). The doc implies all gates return clean skip responses.
- **`session-manager.ts` role** — Doc says it "routes cron messages to default Pi session queue". The session manager doesn't route anything — routing is done by `runtime.resolveTargetSession()`. Session manager manages Pi session lifecycle.

## Missing from Doc

- **`scheduler.sh`** — backward-compatible wrapper script (`exec autonoma-checkin.sh "$@"`) exists in `.autonoma/cron/` but is not listed in Key Files.
- **Message persistence** — `runtime.enqueue()` persists every cron message to the `messages` table (source=cron, direction=inbound) before queuing. Not mentioned in the doc.
- **systemd service file** — doc mentions systemd timer but not the companion `autonoma-scheduler.service` (Type=oneshot) that the timer activates. Both are rendered in `install.mjs`.
- **systemd timer extras** — `OnBootSec=2m`, `AccuracySec=1m`, `Persistent=true` are set but not documented.
- **Legacy crontab cleanup** — `install.mjs` removes old crontab entries during systemd install. Not mentioned.

## Missing from Implementation

No features described in the doc are missing from the implementation. All gates, response shapes, circuit breaker mechanics, stale detection, prompt selection, and maintenance loop behaviors are implemented.
