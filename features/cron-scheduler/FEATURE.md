# Feature: Cron Scheduler

External health-gated periodic prompt injection. An OS-level timer pings the running control surface; the surface decides whether to act based on health state, circuit breakers, and session classification. If the surface is down, nothing happens — cron never starts processes.

## Problem

Autonoma needs periodic proactive behavior: checking stale Claude Code sessions, reviewing Todoist, surfacing idle-window suggestions. This loop must be safe — it must not restart a stopped surface, enqueue prompts when unhealthy, duplicate prompts when Pi is active, or hide scheduling state inside invisible in-process timers.

## Architecture

Three-tier: OS timer → bash script → control surface endpoint.

**OS timer** — systemd user timer (Linux, `OnUnitActiveSec=10m`) or launchd agent (macOS, 600s interval). Fires the bash script on schedule; does nothing else. Timer enable/disable is the feature flag — no app-level config key.

**Bash script** (`~/.autonoma/cron/autonoma-checkin.sh`) — reads token and port from `~/.autonoma/config.json`, POSTs to `/cron/tick` with bearer auth. Fails silently if surface is down (`curl -sf ... || true`). No logic, no SQLite, no process management.

**Control surface endpoint** (`POST /cron/tick`) — runs a gate sequence; first failure skips the tick with a logged reason.

### Gate Sequence

1. **Pi not busy** — if Pi is processing a turn, skip (no duplicate prompt)
2. **Pi session exists** — if session ended/crashed, skip
3. **WhatsApp connected** — if disconnected, skip (Pi can't reach user for confirmation)
4. **No active circuit breakers** — query `health_flags` for unexpired flags; any active flag → skip
5. **Check stale sessions** — query sessions already marked stale by maintenance loop; if stale found, enqueue stale-check prompt
6. **No active working sessions** — if non-stale `working` sessions remain, skip with `no_actionable_state` (active work shouldn't be interrupted). Otherwise enqueue idle-check prompt

### Response

Always 200 (tick succeeded; decision was skip or enqueue). Non-200 only for auth failures or server errors.

```json
{
  "ok": true,
  "action": "enqueued | skipped",
  "reason": "idle_check | stale_check | pi_active | pi_ended | whatsapp_disconnected | circuit_breaker | no_actionable_state",
  "flags": ["rate_limit"]  // only when reason=circuit_breaker
}
```

### Circuit Breakers: `health_flags` Table

SQLite table suppressing cron activity during known-bad states. Schema:

| Column | Type | Purpose |
|--------|------|---------|
| `flag` | TEXT PK | `rate_limit`, `llm_error`, `pi_crash_loop`, etc. |
| `reason` | TEXT | Human-readable trigger description |
| `set_at` | TEXT | ISO timestamp |
| `expires_at` | TEXT NULL | Auto-expiry; NULL = manual clear only |
| `cleared_at` | TEXT NULL | Non-null = inactive |

**Set** by any component detecting a blocking error via `setHealthFlag(db, flag, reason, ttlMinutes?)`. **Checked** at query time — no background cleanup job. **Cleared** three ways: TTL expiry, manual clear, or control surface restart (clears all).

### Stale Detection

A `working` session is stale when both: `last_event_at` > `stallMinutes` (default 15) AND `last_tool_started_at` is NULL or > `toolTimeoutMinutes` (default 60). The endpoint calls `markStaleSessions()` before selecting a prompt.

### Prompt Selection

Two deterministic prompts based on session classification:

- **Stale check** — when stale sessions exist: lists session IDs and last activity, asks Pi to verify tmux state and reconcile
- **Idle check** — when all sessions stopped/idle: asks Pi to review state, transcripts, Obsidian/Todoist context, and suggest next work

Cron messages enter the default Pi session's `TurnQueue` with `source: "cron"` and skip router classification (unlike web/WhatsApp messages).

### Maintenance Loop (Separate)

`runtime.ts` runs a 60-second `setInterval` maintenance loop independent of cron. It pings the blackboard, refreshes WhatsApp status, marks stale sessions, cleans up 24h-old idle sessions (kills tmux), and checks for stuck turns. This is housekeeping — not prompt injection.

## Key Files

| File | Role |
|------|------|
| `src/routes/cron-tick.ts` | `/cron/tick` endpoint — gate sequence, classification, enqueue |
| `src/blackboard/query-health-flags.ts` | `setHealthFlag`, `getActiveHealthFlags`, `clearHealthFlag`, `clearAllHealthFlags` |
| `src/blackboard/migrate.ts` | Creates `health_flags` table (migration v7) |
| `src/contracts/blackboard.ts` | `HealthFlagRow` schema |
| `src/contracts/control-surface-api.ts` | `CronTickAction`, `CronTickReason`, `MessageSource` types |
| `src/pi/turn-queue.ts` | `TurnQueue` — FIFO sequential processing of enqueued items |
| `src/pi/session-manager.ts` | Routes cron messages to default Pi session queue |
| `src/routes/message.ts` | Normalizes "cron" as valid source, skips router for cron |
| `src/runtime.ts` | `startMaintenanceLoop()` — 60s housekeeping (separate from cron) |
| `src/server.ts` | Registers `/cron/tick` route |
| `.autonoma/cron/autonoma-checkin.sh` | Bash script — authenticated curl to `/cron/tick` |
| `.autonoma/cron/com.autonoma.scheduler.plist` | macOS launchd config (600s interval) |
| `.autonoma/install.mjs` | Installs systemd timer/launchd agent, writes bash script |

## Design Principles

- **External timer only** — scheduling owned by OS, not in-process `setInterval`
- **No cold-start** — cron never spawns processes; surface down = silent no-op
- **Health-gated** — circuit breakers prevent burning tokens into known failures
- **Observable** — structured JSON responses captured in systemd journal / launchd logs
- **Single path** — one script, one endpoint, one decision sequence

## Observations

- **resolved** `setHealthFlag` now called from stuck-turn detection. The maintenance loop in `runtime.ts` calls `setHealthFlag(db, "stuck_turn", reason, 30)` when a turn exceeds `toolTimeoutMinutes`, activating the circuit breaker gate in `cron-tick.ts`. A WhatsApp alert is also sent.

- **resolved** `jq` dependency removed from all shell scripts. Config parsing now uses Node.js (already a required dependency).

- **resolved** Gate sequence documented correctly. The 6-step gate sequence in this doc matches the implementation in `cron-tick.ts`.

- **resolved** Duplicate stale marking removed. Cron tick now reads already-marked stale sessions via `getStaleSessions()` instead of calling `markStaleSessions()`. The maintenance loop (60s) is the sole writer of stale status.

- **resolved** Stuck-turn detection now escalates. The maintenance loop sets a `stuck_turn` health flag (30-min TTL) and sends a WhatsApp notification when a turn exceeds `toolTimeoutMinutes`. The health flag triggers the circuit breaker gate in cron, preventing prompt injection into stuck sessions.
