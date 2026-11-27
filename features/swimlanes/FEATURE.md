# Swimlane identity, routes, and order

Design only. Live cutover requires approval after a rehearsal. Root-route behavior is proposed, not yet confirmed.

## Architecture

A swimlane uses its Pi SDK session ID as its sole key and preserves the existing Pi JSONL header ID. Close and reopen keep that key; fork gets a new one. Downstream rows in `sessions` keep their own `session_id` and tmux identity. They refer to the owning swimlane through one `swimlane_id`.

The proposed web routes are `/` for the current default, `/<swimlaneId>` for a specific lane, and `/inbox` for the aggregate Surface. Static routes retain their names. `/api/streams/*` paths stay unchanged; their clients send canonical IDs. No runtime old-ID alias table remains.

## Pseudocode contracts and call graph

```text
planCutover(db, managedSessionRoots, runtimeInventory) -> manifest
  -> verify v26 schema shape and classify Pi parents and downstream children
  -> map linked legacy stream IDs to Pi IDs; protect the current default per owner
  -> classify purge candidates, blocked records, missing files, and surviving links
  -> report row and file counts, conflicts, and projected changes

applyCutover(approvedManifest, quiescedDb)
  -> revalidate manifest; verify restore point
  -> stage verified transcript files in reversible quarantine
  -> transaction: rebuild canonical parents and child references, rewrite links,
     remove approved records, validate integrity, record v27, commit
  -> verify DB and file state; finalize purge after the rollback checkpoint

move(laneId, anchorId, before | after)
  -> authorize; load current owner/pin/lifecycle group under write transaction
  -> seed ranks if needed; compute between current neighbors; update moved row
  -> commit; invalidate status so all clients and shortcuts use server order
```

## Component tree

```text
SidebarSwimlanes [status query and move mutation]
├── DefaultRow [fixed]
└── SwimlaneGroup [server order; search is a projection]
    └── SwimlaneRow [link; Move up / Move down outside search]
```

Each group keeps open/closed and pin boundaries. Null ranks mean newest first (`created_at` for open, `closed_at` for closed), then ID. First manual move seeds the group; new lanes and lanes entering the group get the top position. Reset clears group ranks. Fractional string ranks use SQLite `BINARY` collation. Most moves update one row; a bounded key length triggers compaction of that group only. Integer gaps of 100 or 200 allow only about six or seven repeated midpoint inserts into the same gap.

## Migration and purge plan

1. Inventory every configured active Flitterbot SQLite database by file identity. Rehearse on consistent copies. Current v26 stores durable JSON documents; do not apply `423-stream-sort-order`'s incompatible v25-to-v26 migration. Use its `675bc3b9` commit as a design reference only.
2. The approved purge scope covers both retired unlinked default Pi sessions and legacy unlinked orchestrator Pi sessions. Scope approval permits rehearsal, not live deletion. `stream_id IS NULL` alone never qualifies a row. Protect current defaults per owner, every swimlane-linked Pi session, live Pi runtimes, and live downstream work. Cross-check runtime and tmux state rather than assuming an old DB status or a stored tmux name proves liveness. Do not stop any tmux session. If a candidate owns live downstream work or its ownership is uncertain, block it from the purge.
3. For each eligible Pi ID, enumerate its DB row, exclusively owned messages and message mappings, verified managed JSONL files, and derived search entries. Purge ended downstream rows that belong only to a removed Pi session and have no surviving swimlane or live tmux session. Preserve downstream IDs and records that belong to surviving swimlanes or live work. Block conflicting references for review rather than deleting or reassigning them by inference. Verify transcript header IDs, managed paths, and exclusive ownership. Report missing files separately; never infer a file target from its name alone. Preserve unrelated files and DB records.
4. Stop writers for the approved cutover. Use a manifest and recoverable file staging so a failed SQLite transaction does not strand transcript files. Keep rollback copies only for the agreed recovery window; existing backups or snapshots are outside the active DB cleanup and require a separate retention decision. Verify that approved IDs and file paths are gone from active storage and search indexes. Re-run preflight after an interrupted apply rather than treating partial progress as success.
5. Rewrite confirmed persisted Flitterbot web URLs in typed fields, JSON metadata, and parsed text links. Preserve query strings and fragments. Leave API URLs, foreign hosts, file paths, and prose unchanged. Report links to purge candidates and unresolved IDs instead of sending them to the wrong lane. Validate ownership, row and file counts, foreign keys, link targets, durable settings, and reruns before restarting. No live apply before review of the exact manifest.

## Files

- `src/blackboard/migrate.ts`, `src/blackboard/schema.sql`, `src/contracts/blackboard.ts` — version, canonical tables, and reference validation.
- `src/streams/pi-session-manager.ts`, `src/streams/session-file-placement.ts`, `src/session-file-search.ts` — lifecycle, transcript placement, and index boundaries.
- `src/blackboard/query-streams.ts`, `src/runtime.ts`, `src/contracts/control-surface-api.ts` — canonical status order, identity, and move contract.
- `web/src/routes/`, `web/src/components/sidebar.tsx`, `web/src/lib/stream-route-targets.ts` — canonical navigation, row moves, and shortcut targets.
