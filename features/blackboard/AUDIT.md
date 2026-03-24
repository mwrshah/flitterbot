# Blackboard Feature Audit

Audited 2026-03-24 against `src/blackboard/` and `src/contracts/blackboard.ts`.

## Matches

- **Database wrapper** (`db.ts`): `BlackboardDatabase` class wraps `DatabaseSync`, sets WAL mode, 5s busy timeout, foreign keys. Exposes `exec`, `prepare`, `run`, `get`, `all`, `ping`, `close`. Factory function `openBlackboard()`. All confirmed.
- **Schema in contracts**: `BLACKBOARD_SCHEMA_SQL` constant in `src/contracts/blackboard.ts` is the single source of truth. All row types and status enums live there. Confirmed.
- **Tables**: All 7 data tables + `schema_migrations` exist as described — `workstreams`, `sessions`, `pi_sessions`, `messages`, `whatsapp_messages`, `pending_actions`, `health_flags`. Column definitions, CHECK constraints, foreign keys, and indexes all match.
- **Code organization**: Query/write split by domain matches the table in the doc. All listed files exist at the documented paths.
- **Session lifecycle**: `insertSession` upserts on `session_id` with COALESCE merging. `updateSessionStop` transitions to idle. `markSessionEnded` sets ended status + reason. Confirmed in `query-sessions.ts`.
- **Staleness detection**: `markStaleSessions` and `findStaleCandidates` use both `last_event_at` and `last_tool_started_at` thresholds from config. Confirmed.
- **Injection eligibility**: `getInjectionEligibility` returns ok:true only for idle sessions with a tmux_session. Confirmed.
- **Pi session reconciliation**: `reconcilePreviousPiSessions` ends active pi_sessions for a given role except current runtime instance. Confirmed in `pi-sessions.ts`.
- **WhatsApp reply matching**: `resolveInboundContextRef` in `write-whatsapp.ts` chains three fallbacks (quoted message → latest pending action → latest outbound with context_ref). Confirmed.
- **Workstream lifecycle**: Create, enrich, close/reopen all present in `query-workstreams.ts`. Pi sessions and messages link to workstreams. Confirmed.
- **Health flags**: `setHealthFlag` (upsert with optional TTL), `getActiveHealthFlags`, `clearHealthFlag`, `clearAllHealthFlags` all present in `query-health-flags.ts`. TTL calculated client-side as ISO datetime. Confirmed.
- **No barrel file**: Consumers import directly from individual modules. Confirmed.
- **Open question (health flag callers)**: Still accurate — `setHealthFlag`/`clearHealthFlag` have zero production callers. Only `clearAllHealthFlags` and `getActiveHealthFlags` are used.

## Divergences

1. **Schema version**: Doc says `BLACKBOARD_SCHEMA_VERSION` is currently **10**. Code has **11**.
2. **Migration range**: Doc's Key Files section says migrations go **v1 -> v9**. Code implements **v0 -> v11**. The doc body mentions v10 and v11 migrations but the Key Files block was not updated to reflect this.
3. **Message source enum**: Doc lists `UnifiedMessageSource` sources as `whatsapp | web | hook | cron | init | pi_outbound`. Code also includes **`agent`** (added in v11). The doc body mentions v11 adding `'agent'` to the CHECK constraint, but the Contracts section's source list omits it.
4. **Pi session fields**: Doc describes pi_sessions key fields as "role, runtime_instance_id, pid, model config, and links to a workstream." The actual schema includes additional columns not mentioned: `session_file`, `cwd`, `agent_dir` — these are significant operational fields.
5. **Session fields**: Doc mentions "session_id, tmux_session, cwd, project, model, agent_managed, task_description, todoist_task_id, transcript_path" as key fields. Missing from that list: `project_label`, `permission_mode`, `source`, `session_end_reason` — all present in the schema and row type.

## Missing from Doc

1. **`schema.sql` file**: A standalone `src/blackboard/schema.sql` file (132 lines) exists alongside the `BLACKBOARD_SCHEMA_SQL` constant in contracts. The doc doesn't mention this file or clarify the relationship between the two copies.
2. **`findIdleCleanupCandidates`**: Query function in `query-sessions.ts` that finds sessions idle for N hours or before a given timestamp — not documented.
3. **`getActiveManagedSessionsByPi` / `countActiveManagedSessionsByPi`**: Query functions for Pi-managed session lookups — not documented.
4. **`listRecentlyClosedWorkstreams`**: Query in `query-workstreams.ts` for workstreams closed within N hours — not documented.
5. **`resetAllWorkstreams`**: Bulk operation in `query-workstreams.ts` — not documented.
6. **`mapSessionRow`**: Data mapper converting snake_case DB rows to camelCase `ClaudeSessionListItem` contracts — not documented as a pattern.
7. **Pi session adapter layer**: `pi-sessions.ts` serves as a higher-level adapter that normalizes inputs before delegating to `write-pi-sessions.ts`. The doc lists the file but doesn't describe this adapter pattern.
8. **Transaction strategy**: Migrations use `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` — the concurrency/safety model for migrations is not described.
9. **`HookEventName` / `HookRouteEventName` / `ROUTE_EVENT_TO_HOOK_EVENT`**: Types and mapping constant in contracts for hook event routing — not mentioned in the doc.

## Missing from Implementation

Nothing identified — all features described in the doc are implemented. The doc is a subset of the actual implementation.
