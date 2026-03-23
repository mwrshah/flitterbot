# Spec: Multi-Pi Orchestration — From Single Pi to Concurrent Per-Workstream Agents

## Problem

The runtime creates a single Pi agent session at startup (`runtime.ts:128`). All messages — regardless of workstream — are serialized through one turn queue into one session. This means:

- **No concurrency**: A long-running orchestrator turn for workstream A blocks messages for workstream B and non-work queries.
- **Context pollution**: The single session accumulates context from all workstreams, leading to confusion and faster context exhaustion.
- **No role separation**: The single session uses the orchestrator prompt but also handles Todoist, general queries, and session management — roles that should belong to a dedicated default agent.
- **Workstream lifecycle is incomplete**: `close_workstream` ends the single Pi session, which is catastrophic since it's the only one.

The Pi lifecycle spec (01) built the foundations — session linkage, state machine, soft-delete, close tool. This spec builds the multi-Pi architecture on top of those foundations.

## Approach

### Two agent types, distinct lifecycles

- **Default agent**: Always-on, long-lived. Handles non-workstream messages, Todoist, general queries, session management commands. Created at startup, persists until shutdown. Uses `DEFAULT_AGENT_PROMPT`.
- **Orchestrator agents**: Ephemeral, one per active workstream. Created on demand when the router creates or reopens a workstream. Destroyed when `close_workstream` is called or the runtime detects a crash. Uses `buildOrchestratorPrompt(ctx)`.

### PiSessionManager as the registry

A new `PiSessionManager` class owns the lifecycle of all Pi sessions. The runtime delegates to it instead of holding `this.piSession` directly. The manager maintains:

- One default agent session (keyed `"default"`)
- Zero or more orchestrator sessions (keyed by workstream ID)
- A per-session `TurnQueue` for each active session

Sessions run concurrently — each has its own queue that serializes turns within that session, but different sessions process turns in parallel.

### Message routing after classification

The router classifies as before. The runtime then dispatches to the correct session:

| Classification result | Target session |
|----------------------|----------------|
| `action: "matched"` + open workstream has active orchestrator | That orchestrator |
| `action: "matched"` + open workstream, no orchestrator | Spawn orchestrator, route to it |
| `action: "created"` | Spawn new orchestrator, route to it |
| `action: "reopened"` | Spawn new orchestrator for reopened workstream, route to it |
| `isWorkMessage: false` or no workstream | Default agent |

Hook events (Stop/SessionEnd) look up `pi_session_id` from the CC session record and route to the owning Pi's queue.

Cron ticks always route to the default agent.

### Initial prompt on orchestrator creation

When the router creates a new workstream, the first prompt to the orchestrator is formatted with a workstream prefix and the user's message. The default Pi agent passes all relevant context via the initial message itself — no separate context transfer is needed.

### Classification improvements

The Gemini classification prompt needs additional rules to prevent workstream creation for meta-operations:

- Session management commands ("kill tmux", "close sessions", "check status") → `is_work_message: false`
- Cron health-check messages → `is_work_message: false`
- Workstreams are about repository-scoped work, not infrastructure meta-operations

---

## Functional Requirements

### FR-1: PiSessionManager — session registry and lifecycle

**New module** — `src/control-surface/pi/session-manager.ts`

The `PiSessionManager` manages all Pi agent sessions. It replaces the runtime's direct `this.piSession` reference.

```typescript
interface ManagedPiSession {
  session: AgentSession;
  queue: TurnQueue;
  role: "default" | "orchestrator";
  workstreamId: string | null; // null for default
  piSessionId: string;
  createdAt: string;
}

interface PiSessionManager {
  getDefault(): ManagedPiSession;
  getByWorkstream(workstreamId: string): ManagedPiSession | undefined;
  getByPiSessionId(piSessionId: string): ManagedPiSession | undefined;
  listOrchestrators(): ManagedPiSession[];

  createDefault(config, customTools): Promise<ManagedPiSession>;
  createOrchestrator(workstreamId, workstreamName, repoPath?, customTools?): Promise<ManagedPiSession>;
  destroyOrchestrator(workstreamId: string, reason: string): void;

  disposeAll(): void;
}
```

**Design decisions**:
- The default session is created at startup and is always available. `getDefault()` never returns undefined after initialization.
- Orchestrator sessions are created lazily — only when a message first routes to a workstream that doesn't have one.
- Each `ManagedPiSession` owns its own `TurnQueue`. The queue serializes turns within that session. Different sessions' queues run concurrently.
- The runtime's `enqueue()` method routes to the correct session's queue rather than a global queue.
- `destroyOrchestrator()` calls `session.dispose()`, stops the queue, updates the blackboard row to `ended`, and removes from the map.

**Blackboard integration**:
- Each orchestrator gets its own `pi_sessions` row with `role='orchestrator'` and a reference to the workstream
- The default agent gets a `pi_sessions` row with `role='default'`
- `reconcilePreviousPiSessions` at startup should reconcile both roles

### FR-2: Per-session turn queues with concurrent execution

**Replace the single global queue** with per-session queues.

- The existing `TurnQueue` class is reused as-is — one instance per `ManagedPiSession`.
- The runtime's `enqueue()` becomes a routing function: classify → pick target session → enqueue to that session's queue.
- Queue lifecycle callbacks (`onItemStart`, `onItemEnd`, `onDepthChange`) should include the session identity so the WebSocket hub and session state can attribute events correctly.
- The `PiSessionState` (observability) either becomes per-session or is extended to track multiple sessions. The `/status` endpoint should report all active sessions.

**Concurrency model**: Each queue independently pumps. If workstream A's orchestrator is mid-turn, workstream B's orchestrator and the default agent can still process their queues. This is the primary user-facing improvement.

### FR-3: Message routing — dispatch to correct Pi session

**Update `handleWebSocketMessage()`** and the WhatsApp inbound handler:

After classification:
1. Determine target session using the routing table from the Approach section
2. If the target is an orchestrator that doesn't exist yet, create it via `PiSessionManager.createOrchestrator()`
3. Enqueue to the target session's queue

**Update `handleHook()`**:

For Stop events:
1. Look up the CC session's `pi_session_id` from the blackboard
2. Find the owning Pi session via `PiSessionManager.getByPiSessionId()`
3. Enqueue the hook message to that Pi's queue
4. If no owning Pi is found (session predates multi-Pi, or orchestrator was destroyed), fall back to the default agent

For SessionStart/SessionEnd (bookkeeping only, not forwarded to Pi): no routing change needed — they write to SQLite directly.

### FR-4: Initial prompt on orchestrator creation

When `PiSessionManager.createOrchestrator()` is called because the router created or reopened a workstream, format the first prompt using `buildWorkstreamPrompt()` with the workstream prefix and the user's current message. The default Pi agent includes all relevant context in its initial message — no separate context transfer block is needed.

### FR-5: Default agent role changes

**Remove `close_workstream` tool** from the default agent. Only orchestrators have it (already gated by `role === "orchestrator"` in `createCustomTools()`).

**Add workstream awareness** to the default agent prompt:
- The default agent should know that active workstreams have dedicated orchestrators
- When user asks about a workstream that has an active orchestrator, the default agent should redirect: "That workstream has a dedicated orchestrator handling it. I'll route your message there."
- The default agent can query the blackboard to see active Pi sessions and their workstream assignments

**Update `DEFAULT_AGENT_PROMPT`** to include:
- Awareness that orchestrator agents exist per-workstream
- Instruction to not attempt work that belongs to an active orchestrator
- Retained scope: Todoist, general questions, session management commands, non-work messages

### FR-6: Orchestrator lifecycle

**Creation triggers**:
- Router `action: "created"` — new workstream
- Router `action: "reopened"` — reopened workstream
- Router `action: "matched"` but no active orchestrator — lazy creation for workstreams that lost their orchestrator (crash recovery)

**Creation steps**:
1. Call `createAutonomaAgent()` with `role: "orchestrator"`, `orchestratorContext: { workstreamName, workstreamId, repoPath }`
2. Upsert `pi_sessions` row with `role='orchestrator'`, linked to the workstream
3. Subscribe to session events (streaming, tool use, etc.)
4. Create a `TurnQueue` for the session
5. Register in `PiSessionManager`

**Destruction triggers**:
- `close_workstream` tool execution — the tool already sets Pi session to `ended`
- Runtime detects orchestrator crash (uncaught error in queue processing)
- Runtime shutdown — `disposeAll()`

**Destruction steps**:
1. Stop the orchestrator's turn queue
2. Unsubscribe from session events
3. Call `session.dispose()`
4. Update `pi_sessions` row to `ended` or `crashed`
5. Remove from `PiSessionManager`

**Session storage**: Each orchestrator's session JSONL lives in its own file under `~/.autonoma/control-surface/sessions/`. The SDK's `SessionManager.create(cwd, sessionsDir)` handles file naming. Different orchestrators get different session files automatically since each `createAgentSession` call creates a new session.

### FR-7: Gemini classification improvements

**Update the classification prompt** in `buildClassificationPrompt()`:

Add rules:
```
8. Session management commands (kill tmux, close sessions, check status, restart daemon) are NOT work — set is_work_message to false.
9. Cron health-check messages are NOT work — set is_work_message to false.
10. Workstreams are about repository-scoped coding/engineering work, not meta-operations on the Autonoma system itself.
```

These rules prevent the router from creating workstreams for infrastructure commands that should go to the default agent.

### FR-8: Status and observability updates

**Update `/status` endpoint** to report all active Pi sessions:
```typescript
{
  pi: {
    default: { sessionId, messageCount, busy, queueDepth },
    orchestrators: [
      { sessionId, workstreamId, workstreamName, messageCount, busy, queueDepth },
      ...
    ]
  }
}
```

**Update WebSocket events** to include session identity:
- `queue_item_start`, `queue_item_end` should include `piSessionId` and `workstreamId`
- `pi_surfaced` should include `workstreamId` so the web client can attribute responses

**Auto-surface routing**: Each session's final assistant text is still surfaced to WhatsApp and web. For orchestrators, the surfaced message should include a workstream label so the user knows which orchestrator is speaking.

---

## Acceptance Criteria

1. At startup, the runtime creates a default agent (role `"default"`) and zero orchestrators
2. When the router creates a new workstream, an orchestrator Pi session is spawned and the message routes to it
3. The new orchestrator receives the recent default-agent conversation as context in its first prompt
4. Messages classified to an existing workstream with an active orchestrator route to that orchestrator's queue
5. Non-work messages and messages with no workstream route to the default agent
6. Hook Stop events route to the Pi session that owns the CC session (via `pi_session_id` lookup)
7. Cron ticks route to the default agent only
8. Each Pi session has its own turn queue; turns within a session are serialized, but different sessions run concurrently
9. `close_workstream` destroys the orchestrator session and removes it from the registry
10. The default agent does not have `close_workstream` tool
11. Session management commands ("kill tmux", "check status") do not create workstreams
12. `/status` endpoint reports all active Pi sessions (default + orchestrators)
13. Surfaced messages include workstream attribution so the user knows which agent is responding

## Files Likely Touched

### New Files
- `src/control-surface/pi/session-manager.ts` — `PiSessionManager` class (session registry, lifecycle, routing)

### Runtime
- `src/control-surface/runtime.ts` — Replace `this.piSession` with `PiSessionManager`; update `enqueue()` to route; update `handleHook()` to route by `pi_session_id`; update `start()` to create default agent; update `stop()` to dispose all; update `processQueueItem()` to be per-session; update `getStatus()` for multi-session reporting
- `src/control-surface/queue/turn-queue.ts` — Minor: add session identity to callbacks (or keep as-is if identity is tracked externally)

### Agent Creation
- `src/control-surface/pi/create-agent.ts` — Potentially update `createAutonomaAgent()` to accept a per-session `sessionsDir` or session label for file separation; ensure concurrent calls don't collide on session files

### System Prompts
- `src/control-surface/pi/system-prompts/default-agent.ts` — Add awareness of orchestrator agents, workstream delegation language
- `src/control-surface/pi/system-prompts/orchestrator.ts` — No changes expected (already scoped)

### Router
- `src/control-surface/router/classify.ts` — Add classification rules for session management commands and cron messages

### Observability
- `src/control-surface/pi/session-state.ts` — Extend to track multiple sessions or create per-session instances
- `src/control-surface/ws/hub.ts` — Update broadcast events to include session/workstream identity

### Contracts
- `src/contracts/index.ts` — Update `StatusResponse` type for multi-session Pi status; update WebSocket event types

### History
- `src/control-surface/pi/history.ts` — Used for context transfer (read default agent's messages in `"input"` mode)
