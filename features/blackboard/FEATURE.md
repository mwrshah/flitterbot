# Feature: Blackboard (SQLite State Layer)

Shared SQLite database (`~/.autonoma/blackboard.db`) providing a real-time, queryable view of all Autonoma state. Consumers: orchestrator (Pi), cron, WhatsApp daemon, web app, hooks.

## Problem

Multiple Claude Code sessions run concurrently across tmux and worktrees. The orchestrator, cron, WhatsApp, and web app all need session status, task assignments, pending messages, and pending user decisions. Without shared state each consumer would independently query tmux, parse transcripts, and reconcile — duplicating logic everywhere.

## Architecture

**Database wrapper** (`db.ts`): `BlackboardDatabase` class wraps Node's `DatabaseSync`. Constructor creates the directory, opens the file, sets WAL mode + busy timeout + foreign keys, and runs migrations. Exposes `exec`, `prepare`, `run`, `get`, `all`, `ping`, `close`.

**Schema** is defined as a SQL string in `src/contracts/blackboard.ts` (`BLACKBOARD_SCHEMA_SQL`) — the contracts package is the single source of truth for the schema and all row types. The local `schema.sql` is a reference copy.

**Migrations** (`migrate.ts`): versioned (currently v9), tracked in `schema_migrations`. Fresh databases get the full schema in one shot. Existing databases step through incremental migrations. Legacy upgrade handles the v1–v3 transition (drops `events`/`agents` tables, remaps `running` → `working` status). Migrations v4–v9 add workstreams, refine pi_session statuses, add the unified `messages` table, add `health_flags`, and add `pi_sessions.workstream_id`.

**Code organization**: query modules (read) and write modules (write) are split by domain:

| Domain | Query | Write |
|--------|-------|-------|
| Claude sessions | `query-sessions.ts` | (inserts/updates in same file) |
| Pi sessions | `query-pi-sessions.ts` | `write-pi-sessions.ts` |
| WhatsApp messages | `query-whatsapp.ts` | `write-whatsapp.ts` |
| Unified messages | `query-messages.ts` | `write-messages.ts` |
| Pending actions | (queries in `query-whatsapp.ts`) | `write-pending-actions.ts` |
| Workstreams | `query-workstreams.ts` | (inserts/updates in same file) |
| Health flags | `query-health-flags.ts` | (in same file) |

`index.ts` re-exports everything as the public API.

## Tables

**`workstreams`** — Named units of work (open/closed). Link sessions, pi_sessions, and messages to a logical task context. Fields: id, name, repo_path, worktree_path, status, created_at, closed_at.

**`sessions`** — Claude Code sessions. Status: working → idle → stale → ended. Linked to a workstream and pi_session. Key fields: session_id, tmux_session, cwd, project, model, agent_managed, task_description, todoist_task_id, transcript_path. Timestamps: started_at, ended_at, last_event_at, last_tool_started_at.

**`pi_sessions`** — Pi orchestrator runtime sessions (separate from Claude Code sessions). Status: active | waiting_for_user | waiting_for_sessions | ended | crashed. Tracks role, runtime_instance_id, pid, model config, and links to a workstream.

**`messages`** — Unified message log across all channels. Source: whatsapp | web | hook | cron | init | pi_outbound. Direction: inbound | outbound. Links to workstream. Supports conversation history queries per-workstream with time windowing.

**`whatsapp_messages`** — WhatsApp-specific message tracking with delivery status lifecycle (pending → sent → delivered | failed). Supports reply matching via `context_ref` and `wa_message_id`.

**`pending_actions`** — User decisions that survive process restarts. Kind: restart_session, approve_change, clarify, etc. Status: pending → resolved | expired | canceled. Linked to sessions and Todoist tasks via optional FKs.

**`health_flags`** — Circuit-breaker flags with optional TTL. Set/cleared by the control surface to signal degraded subsystems.

## Key Behaviors

**Session lifecycle**: `insertSession` upserts on session_id — a resume/compact re-registers the same session. `updateSessionStop` transitions working → idle. `markSessionEnded` sets ended status + reason + clears tool timestamp.

**Staleness detection**: `markStaleSessions` finds working sessions whose `last_event_at` exceeds the stall threshold AND whose `last_tool_started_at` (if set) exceeds the tool timeout. Both thresholds come from `AutonomaConfig` (stallMinutes, toolTimeoutMinutes).

**Injection eligibility**: `getInjectionEligibility` evaluates whether a session can receive injected prompts — returns ok:true only for idle sessions with a tmux_session. Ended, stale, and actively-working sessions are rejected.

**Pi session reconciliation**: On startup, `reconcilePreviousPiSessions` ends all active pi_sessions for a given role except the current runtime instance — prevents ghost sessions from prior crashes.

**WhatsApp reply matching**: `resolveInboundContextRef` chains three fallbacks: (1) look up the quoted message's context_ref, (2) find the latest pending action's context_ref, (3) fall back to the latest outbound message with a context_ref.

**Workstream lifecycle**: Create → enrich with repo/worktree paths → close/reopen. Pi sessions and messages link to workstreams for scoped queries.

## Contracts

All row types and status enums live in `src/contracts/blackboard.ts`:
- `ClaudeSessionStatus`, `PiSessionStatus`, `WorkstreamStatus`
- `WhatsAppMessageDirection`, `WhatsAppMessageStatus`, `PendingActionStatus`
- `UnifiedMessageSource`, `UnifiedMessageDirection`
- `HookEventName`, `HookRouteEventName`
- Schema version: `BLACKBOARD_SCHEMA_VERSION` (currently 9)

## Key Files

```
src/blackboard/
  db.ts                    — BlackboardDatabase class, open/ping helpers
  migrate.ts               — Versioned migration logic (v1→v9)
  index.ts                 — Public API re-exports
  schema.sql               — Reference copy of full schema
  query-sessions.ts        — Session CRUD, staleness, injection eligibility
  query-pi-sessions.ts     — Pi session reads + delegates to write module
  query-whatsapp.ts        — WhatsApp + pending action reads
  query-messages.ts        — Unified message reads, conversation history
  query-workstreams.ts     — Workstream CRUD + pi session lookups
  query-health-flags.ts    — Health flag set/get/clear
  write-messages.ts        — Unified message inserts
  write-pending-actions.ts — Pending action create/resolve
  write-pi-sessions.ts     — Pi session upsert/touch/close
  write-whatsapp.ts        — WhatsApp message inserts + status transitions
src/contracts/blackboard.ts — Schema SQL, row types, status enums, version
```

## Observations

**attention!** `schema.sql` and `contracts/blackboard-schema.sql` are stale — both are identical to each other but behind `BLACKBOARD_SCHEMA_SQL` in `contracts/blackboard.ts`. They're missing `pi_sessions.workstream_id` (v9), the `health_flags` table (v7), and the `idx_pi_sessions_workstream` index. The contracts SQL is the one `migrate.ts` actually uses for fresh databases; these files are dead reference copies that will mislead anyone reading them.

**attention!** The barrel export (`index.ts`) is never imported. Every external consumer (`runtime.ts`, `whatsapp/daemon.ts`, `pi/session-manager.ts`, `routes/`, `custom-tools/`, etc.) imports directly from individual modules (`blackboard/query-sessions.ts`, `blackboard/write-whatsapp.ts`, etc.). The barrel re-exports 66 symbols; roughly 25 of those have zero external callers. The file exists but serves no purpose.

**attention!** `sessions.launch_id` is always written as `null`. `insertSession` (`query-sessions.ts:281`) hardcodes `null` for the launch_id parameter. No other code path writes a non-null value. The column exists in the schema and survives through legacy migration but is dead.

**attention!** `WhatsAppMessageStatus` includes `'processed'` in both the type and the schema CHECK constraint, but no code path ever writes this status. The actual lifecycle is pending → sent → delivered | failed. `'processed'` is a phantom status.

**TBD!** `setHealthFlag` and `clearHealthFlag` have zero callers outside the blackboard module. The only health_flags usage is `clearAllHealthFlags` called once at runtime startup (blanket reset) and `getActiveHealthFlags` read by the cron-tick route. The circuit-breaker infrastructure exists but no subsystem sets flags — it's plumbing with no consumers.

**TBD!** `query-pi-sessions.ts` is misnamed — it imports from `write-pi-sessions.ts` and re-exports write operations (`upsertPiSession`, `touchPiPrompt`, `touchPiEvent`, `endPiSession`, `reconcilePreviousPiSessions`). All external callers use it for writes. The query/write split documented in the Architecture table is not accurate for this domain; `query-pi-sessions.ts` is effectively the combined facade.

**TBD!** Pending action `kind` has no schema constraint or type enum — it's a freeform string. The FEATURE.md lists "restart_session, approve_change, clarify" but the only kind actually written in the codebase is `"whatsapp_auth_expired"` (in `whatsapp/daemon.ts`). The other kinds may be passed through from external callers via `PendingActionRequest`, but no enum enforces the contract.
