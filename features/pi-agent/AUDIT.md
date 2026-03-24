# Pi Agent — FEATURE.md Audit

Audit of `features/pi-agent/FEATURE.md` against the codebase at commit `58182b8`.

---

## Matches

These parts of the doc accurately reflect the implementation.

- **Architecture flow** — `enqueue() → resolveTargetSession() → TurnQueue → processQueueItem() → subscribeToPiSession()` matches `runtime.ts`.
- **Session manager** — `PiSessionManager` owns `ManagedPiSession` instances (one default, zero-or-more orchestrators keyed by workstream). Confirmed in `src/pi/session-manager.ts`.
- **Message routing** — `resolveTargetSession()` (runtime.ts:588-612) implements exactly the described priority: direct `_targetSessionId` → cron to default → router-matched workstream → default fallback.
- **Roles** — Default agent (triage, no code) and orchestrator (workstream-scoped, delegates to Claude Code) are correctly described.
- **Custom tools** — All six tools exist with the described role-gating:
  - Shared: `query_blackboard`, `reload_resources`
  - Default-only: `create_workstream`, `enqueue_message`
  - Orchestrator-only: `create_worktree`, `close_workstream`
- **Standard SDK tools** — `read`, `bash`, `grep` provided by Pi SDK, not custom tools. Correct.
- **Session lifecycle** — Creation, event subscription, state tracking, teardown, rehydration all match implementation.
- **TurnQueue** — FIFO with sequential pump, one turn at a time. Confirmed in `src/pi/turn-queue.ts`.
- **Prompt construction** — `buildDefaultAgentPrompt`, `buildOrchestratorPrompt`, `buildClassificationPrompt` all exist in `src/prompts/` with the described signatures.
- **`formatPromptWithContext()`** — Returns `item.text` as-is. Confirmed.
- **Hook integration** — `handleHook()` processes `session-start`, `stop`, `session-end`. On `stop`, extracts last assistant text from transcript and enqueues to the owning Pi session. Session matching by `pi_session_id`, `workstream_id`, or worktree path. All confirmed.
- **Key files table** — All listed files exist at the described paths with the described purposes.
- **Dependencies** — Blackboard (SQLite), Pi SDK packages, WebSocket hub. Correct.
- **Observations section** — All six resolved items accurately describe the current state of the code.

---

## Divergences

Where the doc and implementation disagree.

### Steer bypass has two layers, doc describes one

The doc describes steer bypass as happening in the TurnQueue ("steer items bypass when the queue is busy and the session is streaming"). In reality there are **two** steer bypass paths:

1. **`runtime.enqueue()`** (runtime.ts:241-252) — checks `target.queue.isBusy()`, delivers directly via `session.prompt()` with `streamingBehavior: "steer"`. This is the primary path.
2. **`TurnQueue.enqueue()`** (turn-queue.ts:44-48) — checks `this.processing`, calls `processItem()` directly. This is a secondary safety net.

The doc's Architecture section mentions the runtime-level bypass; the TurnQueue section mentions the queue-level bypass. Neither acknowledges both layers exist.

### TurnQueue section still references "streaming"

The TurnQueue section says steer items bypass "when the queue is busy and the session is streaming." The `isStreaming` guard was removed (noted in Observations), but the main TurnQueue description wasn't updated. The actual check is `this.processing` — not streaming state.

### Hook routing has a default fallback not mentioned in doc

The doc says sessions are matched by `pi_session_id`, `workstream_id`, or worktree path. In practice, if none of these match, `handleHook()` falls back to the **default session** (runtime.ts:412-414). This fallback isn't documented.

---

## Missing from Doc

Implementation details not captured in FEATURE.md.

### `directSessionMessage()` (manage-session.ts)

`src/custom-tools/manage-session.ts` exports `directSessionMessage()` — injects messages directly into Claude Code sessions via tmux. Exposed as a runtime method (`runtime.directSessionMessage()`). Not a Pi custom tool, but a significant runtime capability not mentioned anywhere in the doc.

### Hook `session-start` bookkeeping

`handleHook()` does substantial work on `session-start` events beyond what the doc describes: it inserts Claude Code sessions into the `sessions` table with `pi_session_id`, `workstream_id`, `tmux_session`, `task_description`, `todoist_task_id`, and auto-resolves workstream ownership from `cwd` path matching. The doc only describes the `stop` hook behavior.

### Hook `session-end` handling

The `session-end` hook marks sessions as ended in SQLite with a reason. Not mentioned in doc.

### `close_workstream` is re-entrant and does merge+push

The doc says `close_workstream` cleans up git worktree and closes the workstream. The actual implementation (`src/custom-tools/close-workstream.ts`) does significantly more: merges the worktree branch to main, pushes to origin, handles merge conflicts, and is re-entrant (detects already-merged state).

### `create_worktree` tries `git gtr` first

The doc says it creates a git worktree from `origin/main`. The implementation tries `git gtr` (Git Town) first and falls back to raw `git worktree` commands, and also registers Git Town parent config.

### Queue error handling on orchestrator crash

When `processQueueItem()` catches an error for an orchestrator, it auto-destroys the orchestrator (`destroyOrchestrator(wsId, "crashed")`). This crash-recovery behavior isn't documented.

### `close_workstream` self-destruct detection

After each turn ends, `runtime.ts` checks if the last tool call was `close_workstream` and, if so, auto-destroys the orchestrator (runtime.ts:708-712, 740-758). This post-turn detection logic isn't documented.

### WebSocket event types

The implementation broadcasts specific event types (`text_delta`, `queue_item_start`, `queue_item_end`, `status_changed`, `workstreams_changed`, `pi_surfaced`, etc.) that aren't enumerated in the doc.

---

## Missing from Implementation

Things described in the doc that couldn't be verified in code.

### Nothing material found

All features and behaviors described in FEATURE.md are implemented. The doc is conservative — it describes less than what exists rather than claiming unimplemented features.
