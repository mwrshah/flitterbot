# Pi Session File Archival

## Problem

Flitterbot keeps every Pi JSONL file in `~/.flitterbot/control-surface/sessions/`, including files for closed, unpinned streams. Pi owns the absolute pathname while a runtime can append, so moving a live file splits history between the archived pathname and a newly recreated file at the old pathname.

Stream close, Pi settlement, runtime disposal, terminal database state, pin state, and physical file placement therefore form one lifecycle. The existing `pendingDestroy` callback does not provide that lifecycle boundary: tool close ends the database row before Pi finishes writing, idle API close can leave a live runtime indefinitely, and reopen can overlap asynchronous disposal.

## Goals

- Every stream has exactly one immutable Pi session identity and at most one associated JSONL file.
- Open streams keep their Pi file in `control-surface/sessions/`.
- Closed pinned streams keep their Pi file in `control-surface/sessions/` without activating Pi.
- Closed unpinned streams keep their Pi file in `control-surface/archived-sessions/`.
- Close preserves tool results, steering messages, final assistant output, retries, compaction, and queued Bash entries before moving files.
- Reopen restores and validates the file before Pi opens it.
- Pin, unpin, close, reopen, activation, compaction, and destruction cannot race for one stream.
- Missing, unmaterialized, or identity-mismatched stream files hard-fail; Flitterbot never creates a successor Pi session for an existing stream.
- Interrupted moves recover at startup without a second archival state in SQLite.
- Different streams continue operating concurrently.

## Non-goals

- Archive or retention columns in SQLite.
- Background file watchers or movers.
- Moving default-agent or legacy unowned Pi files.
- Garbage collection or deletion of archived sessions.
- Rewriting Pi `parentSession` lineage paths.
- Cross-filesystem copy/delete fallback between sibling control-surface directories.
- Changing the seven-day sidebar or aggregated Surface-history policy.

## Architecture

### Ownership

`TurnQueue` owns normal prompt and steering writes. `PiSessionManager` owns stream lifecycle and out-of-band Pi mutations through one stable promise-tail gate keyed by `streamId`. The gate belongs to the manager rather than `ManagedPiSession` or `piSessionId`, so it remains stable across activation, `/clear`, destruction, reopen, and rehydration.

The gate does not wrap an entire model turn. A tool such as `close_swimlane` runs inside that turn and cannot reacquire a non-reentrant gate. Instead, a successful tool close records `closeRequested`; finalization joins the `TurnQueue` settlement boundary with the lifecycle gate. Stream-backed `/clear` is rejected because a stream's Pi identity is immutable.

The queue exposes a true idle boundary that includes its current item and steering-child promises. Pi settlement completes before the queue item resolves. Runtime disposal is awaited only after this boundary.

### Placement invariant

```text
stream.status == open OR stream.pinned == true
  => the stream's pi_sessions.session_file is in control-surface/sessions/

stream.status == closed AND stream.pinned == false
  => the stream's pi_sessions.session_file is in control-surface/archived-sessions/
```

Stream state is authoritative. `pi_sessions.status` does not determine placement because Pi events can transiently update it during close.

Placement is an idempotent, per-file operation:

```text
source exists, destination absent
  => atomically hard-link destination without clobbering, unlink source, and update pi_sessions.session_file

source absent, destination exists
  => recover interrupted move by updating pi_sessions.session_file

source and destination both exist with the same inode
  => complete the interrupted link-before-unlink move

source and destination both exist with different inodes
  => refuse to overwrite and report corruption

neither exists and session_file is materialized
  => create an empty Pi session at the desired path with the persisted ID, cwd, and start time

session_file is null
  => classify as unmaterialized and fail because there is no safe managed filename

path outside the two managed directories
  => refuse relocation
```

The two directories share a parent, so movement stays on one filesystem. File movement completes synchronously inside the stream gate. SQLite cannot share a transaction with the filesystem; startup reconciliation repairs the move-first crash window.

### Identity

Every lifecycle operation validates its expected Pi ID after acquiring the gate. Activation and reopen also validate that a materialized JSONL header ID equals `pi_sessions.pi_session_id`.

`pi_sessions.stream_id` is unique when non-null, so SQLite enforces one Pi session per stream. Stream creation rolls back its stream row if Pi creation fails, and startup enumerates every stream so a legacy zero-Pi stream hard-fails reconciliation. Once inserted, a Pi row cannot acquire or change stream ownership; detaching a row cannot make it assignable to another stream. A stream Pi identity never changes. When a materialized file is absent from both managed directories, reconciliation hydrates a valid empty Pi JSONL with the persisted identity rather than creating a successor; the lost conversation history cannot be recovered. Activation and reopen still hard-fail when `session_file` is null or an existing JSONL header has the wrong identity. Existing databases with duplicate stream-linked Pi rows fail startup with a migration error until the legacy duplicate is resolved explicitly.

The `close_swimlane` tool uses its bound stream ID. A model-supplied stream ID cannot close or terminate another stream.

### Close boundary

Close validates all non-destructive prerequisites before terminating downstream sessions. Tool close performs commit, merge, and push work during the active turn, records a close request, and lets Pi persist the tool result and final response. Direct idle close reaches the same finalizer immediately. Direct busy close waits behind the existing queue operation.

Finalization:

1. validates the authoritative Pi row, file topology, and JSONL identity without mutation;
2. stops new queue work;
3. waits for the current item and steering children;
4. confirms Pi is settled;
5. awaits `runtime.dispose()` and extension shutdown;
6. transactionally marks the stream closed and the current Pi row ended;
7. removes runtime maps;
8. re-reads status and pin state;
9. reconciles the stream's unique Pi file;
10. broadcasts the closed state.

`agent_end` is not a close boundary. Pi can retry, compact, continue queued work, and flush queued Bash messages before `agent_settled`.

### Reopen and pin ordering

Reopen performs a non-mutating file/header preflight, then uses DB-first ordering:

1. acquire the stream gate and validate the expected Pi ID;
2. inspect the stream's unique Pi row, physical file, and header identity;
3. mark the stream open;
4. restore the valid file to `sessions/` and update its DB path;
5. rehydrate the dormant manager with the same Pi identity;
6. activate lazily on first work;
7. broadcast reopened.

Closed pin sets `pinned = true` first, then restores the stream's file without activating Pi. Closed unpin clears the pin first, then archives that file. Pin changes on open streams require no movement.

Startup reconciles placement before open-stream rehydration. Secondary WhatsApp default-stream recovery uses the same reopen operation rather than directly changing the stream row.

## Pseudocode Contracts and Call Graph

```ts
type ExpectedPiSessionId = string | null;

type StreamOperationContext = {
  streamId: string;
  expectedPiSessionId: ExpectedPiSessionId;
};

type CloseRequest = {
  streamId: string;
  piSessionId: string;
  requestedBy: "tool" | "api";
};

type SessionFilePlacement = "active" | "archived";

type SessionFileRecord = {
  piSessionId: string;
  streamId: string;
  sessionFile: string;
};

PiSessionManager.withStreamOperation<T>(
  context: StreamOperationContext,
  operation: () => Promise<T>,
): Promise<T>

TurnQueue.waitForIdle(): Promise<void>
TurnQueue.stopAndWait(): Promise<void>

reconcileStreamSessionFiles(
  blackboard: BlackboardDatabase,
  streamId: string,
  sessionsDir: string,
  archivedSessionsDir: string,
): SessionFileReconciliationResult

finalizeStreamClose(
  streamId: string,
  expectedPiSessionId: string,
): Promise<void>

reopenStreamSession(
  streamId: string,
  expectedPiSessionId: ExpectedPiSessionId,
): Promise<ManagedPiSession>
```

Production close:

```text
close_swimlane tool
  → bound stream/Pi validation
  → close preflight + git work
  → managed.closeRequested = request
  → Pi persists tool result and final response
  → TurnQueue settles parent and steering children
  → PiSessionManager.withStreamOperation
    → finalizeStreamClose
      → stopAndWait
      → await runtime.dispose
      → finalize stream + Pi rows in SQLite
      → remove managed mappings
      → reconcileStreamSessionFiles
      → streams_changed(closed)
```

Production context-menu close:

```text
POST /api/streams/:id/close
  → PiSessionManager.withStreamOperation
    → wait for TurnQueue idle
    → validated close work
    → finalizeStreamClose
```

Production reopen:

```text
POST /api/streams/:id/reopen
  → PiSessionManager.withStreamOperation
    → inspect the unique Pi row and JSONL header
    → mark stream open
    → reconcileStreamSessionFiles
    → rehydrate the same valid Pi session or hard-fail
    → streams_changed(reopened)
```

Production pin:

```text
POST /api/streams/:id/pin
  → PiSessionManager.withStreamOperation
    → update pinned state
    → reconcileStreamSessionFiles
    → streams_changed(pinned)
```

Startup:

```text
ControlSurfaceRuntime.start
  → ensure sessions and archived-sessions directories
  → reconcile each stream's unique Pi file
  → create default agent
  → rehydrate open stream sessions
  → recover secondary WhatsApp default streams through common reopen
```

Tests:

```text
runtime lifecycle fixture
  → real TurnQueue + PiSessionManager
  → controlled fake Pi runtime/event sequence
  → temporary sessions/archive directories
  → SQLite blackboard
  → assert queue settlement, runtime maps, DB state, JSONL identity, and placement
```

## Delivery Plan

### Stage 1 — Lock down lifecycle behavior

Add integration fixtures and failing tests for current close, reopen, startup, and pin behavior before changing coordination. Include the installed Pi storage contract: moving a live file recreates a headerless fragment, while opening an explicit dormant path is supported.

Acceptance gate:

- Tests reproduce idle-close zombies, post-close status resurrection, close/reopen overlap, missing files, and header-ID mismatch.
- Tests distinguish `agent_end` from settled completion.
- Tests prove different streams can execute concurrently.

### Stage 2 — Upgrade `TurnQueue` settlement

Make queue idleness awaitable. Track steering deliveries as children of the active item and do not report the item settled while a child delivery remains unresolved. Keep normal prompt and steering ownership in `TurnQueue`.

Acceptance gate:

- `waitForIdle()` resolves only after parent and steering work finish.
- `stopAndWait()` rejects new items and drains already accepted work deterministically.
- Queue tests cover success, failure, stop, steering, and concurrent enqueue timing.

### Stage 3 — Add the stable stream operation gate

Add one promise-tail map in `PiSessionManager`. Serialize lifecycle and out-of-band operations per stream while allowing cross-stream concurrency. Validate expected Pi identity after gate acquisition. Route activation, destruction, cwd switch, compact, prune, fork source access, reload, model/thinking changes, and direct lifecycle mutations through the gate in small batches.

Acceptance gate:

- Failed operations do not poison the promise tail.
- Activation cannot complete after destruction.
- Stream-backed reset is rejected, so close cannot operate on a different Pi identity.
- No additional lifecycle maps or state machines are introduced.

### Stage 4 — Make destruction quiescent and awaitable

Replace fire-and-forget `destroyStreamSession()` with an async finalizer. Remove destruction from `agent_end`; observe settled queue completion instead. Await Pi shutdown before removing manager mappings. Keep shutdown behavior for open streams separate from genuine close.

Acceptance gate:

- Map removal proves Pi can no longer append.
- Idle destruction completes without waiting for a future Pi event.
- Active destruction cannot split or truncate JSONL history.

### Stage 5 — Centralize and harden close

Bind close to the tool’s stream and expected Pi ID. Move destructive downstream termination after close preflight. Remove mid-turn `endPiSession()`. Use one finalizer for tool close and API close, with terminal stream/Pi updates committed together after settlement.

Acceptance gate:

- Failed preflight or merge leaves downstream sessions and stream lifecycle unchanged.
- Tool results and final assistant output are present before disposal.
- Concurrent close requests linearize to one result.
- No post-close event resurrects the terminal Pi row.

### Stage 6 — Centralize and harden reopen

Validate the stream's physical file and header identity. Restore DB-first semantics while moving restoration before Pi activation. Hard-fail unmaterialized, missing, or invalid recovery cases without changing Pi identity. Route secondary WhatsApp default-stream reopen through the same operation.

Acceptance gate:

- Reopen never activates from `archived-sessions/`.
- Missing, unmaterialized, and identity-mismatched files leave the stream unchanged and return a hard failure.
- Reopen waits for prior disposal and cannot revive a stale managed object.

### Stage 7 — Add idempotent placement

Add `archived-sessions` as a derived control-surface directory, not a user configuration knob. Implement no-clobber, same-filesystem movement and DB path updates for the stream's unique Pi row. Add startup recovery for move-first interruption and collision detection.

Acceptance gate:

- Open and pinned files are active; closed-unpinned files are archived.
- Stream-backed `/clear` hard-fails and cannot create a second Pi row or file.
- Both-path conflicts never overwrite data.
- Target-only interrupted moves recover.
- Legacy default and unowned files remain untouched.

### Stage 8 — Connect pinning and startup cutover

Make pin mutation asynchronous and gated. Restore closed pinned files and archive closed unpinned files. Run global reconciliation before rehydration. Archive closed files before `wipeStreamsOnStart` deletes stream ownership.

Acceptance gate:

- Repeated pin/unpin requests end in the placement dictated by final DB state.
- Restart at each simulated move window converges to the invariant.
- The initial cutover safely processes the existing stream-owned backlog.

### Stage 9 — Finish browser lifecycle behavior

When unpin removes an expired closed stream from status, redirect or disable its active chat. Keep direct history reads based on `pi_sessions.session_file`; readers require no archive-specific fallback.

Acceptance gate:

- The browser cannot send to a closed, unavailable session.
- Pinned closed history remains directly readable.
- Existing seven-day Surface and sidebar policies remain unchanged.

### Stage 10 — Pin and protect the Pi contract

Pin the Pi coding-agent dependency or make its storage-contract integration test mandatory during upgrades. Test explicit-path resume, delayed first flush, settlement ordering, and append behavior.

Acceptance gate:

- A Pi upgrade cannot silently change the ownership assumptions used by archival.
- Full lifecycle, typecheck, formatting, and existing browser-history tests pass.

## Release Strategy

Stages 1–6 upgrade core lifecycle without moving production files. Each stage is independently reviewable and leaves `sessions/` as the only placement. Stage 7 introduces the reconciler behind completed lifecycle primitives. Stage 8 performs the physical cutover and startup migration. Stage 9 completes the user-facing edge case. Stage 10 protects the upstream contract.

The cutover has no compatibility branch and no second source of truth. Rollback moves archived files back to `sessions/` and updates `pi_sessions.session_file`; the lifecycle upgrades remain valid independently of archival.

## Files

- `docs/session-file-archival/FEATURE.md` — create: canonical lifecycle, placement, and staged delivery contract.
- `src/config/load-config.ts` — modify: derive and create `controlSurfaceArchivedSessionsDir`.
- `src/streams/turn-queue.ts` — modify: expose parent-plus-steering settlement and async stop.
- `src/streams/pi-session-manager.ts` — modify: own the stable stream gate, async destruction, close finalization, identity validation, and gated mutations.
- `src/streams/pi-session-state.ts` — modify: retain only runtime state that remains necessary after lifecycle centralization.
- `src/streams/pi-subscribe.ts` — modify: stop destroying on `agent_end` and expose settled lifecycle where required.
- `src/streams/create-agent.ts` — modify: enforce restore-before-resume and active session-directory ownership.
- `src/streams/session-file-placement.ts` — create: idempotent per-file placement and interrupted-move recovery.
- `src/runtime.ts` — modify: delegate close, reopen, pin, startup reconciliation, and WhatsApp recovery to `PiSessionManager`; remove overlapping guards.
- `src/custom-tools/close-swimlane.ts` — modify: separate close preflight/git work from terminal lifecycle mutation and downstream termination ordering.
- `src/blackboard/schema.sql`, `src/contracts/blackboard.ts`, and `src/blackboard/migrate.ts` — modify: enforce one non-null `pi_sessions.stream_id` row and hard-fail legacy duplicates.
- `src/blackboard/query-streams.ts` — modify: provide the unique stream Pi row and transaction-safe final close/reopen operations without bypass entry points.
- `src/blackboard/write-pi-sessions.ts` — modify: update explicit session paths without changing stream Pi identity.
- `src/routes/pin-stream.ts` — modify: await the asynchronous gated pin operation.
- `src/routes/reopen-stream.ts` — reference: common authenticated reopen entry point.
- `src/routes/browser-streams.ts` — reference: history already follows the DB session-file path.
- `web/src/components/sidebar.tsx` — modify: handle asynchronous pin lifecycle and unavailable-current-stream navigation.
- `web/src/routes/streams.$piSessionId.tsx` — modify: redirect when unpin removes the selected closed stream.
- `web/src/components/common/message-input.tsx` — modify: prevent sends to unavailable closed sessions.
- `web/tests/turn-queue.test.ts` — create or modify: settlement and steering-child coverage.
- `web/tests/pi-session-lifecycle.test.ts` — create: close, reopen, disposal, identity, pin, and race-injection integration coverage.
- `web/tests/session-file-placement.test.ts` — create: placement matrix, interrupted moves, collisions, and startup cutover coverage.
- `package.json` — modify: pin Pi or enforce the storage-contract test in the standard test command.
