# Feature: Pi Agent

Autonoma's AI layer — Pi sessions that receive messages, think, use tools, and stream responses. Two roles: a **default** agent (always-on triage) and per-workstream **orchestrator** agents. Each role gets a tailored system prompt and role-gated custom tools.

## Architecture

```
inbound message → runtime.enqueue()
                    ↓
              resolveTargetSession()     ← routes by metadata / workstream match
                    ↓
              TurnQueue.enqueue()        ← FIFO, one turn at a time per session
                    ↓
              processQueueItem()         ← prompts Pi via formatPromptWithContext()
                    ↓
              subscribeToPiSession()     ← streams events to WebSocket clients
```

**Session manager** (`PiSessionManager`) owns all `ManagedPiSession` instances — one default, zero-or-more orchestrators keyed by workstream ID. On startup the runtime creates the default session and rehydrates orchestrators for any open workstreams persisted in SQLite.

**Message routing** (`resolveTargetSession`): direct-targeted session ID takes priority; cron always goes to default; router-matched workstream routes to its orchestrator; everything else falls to default.

**Steer delivery**: messages with `deliveryMode: "steer"` bypass the queue when the session is actively streaming — delivered directly via `session.prompt()` with `streamingBehavior: "steer"`.

## Roles

### Default agent
Always-on primary interface. Triages user messages, answers directly for simple queries, and delegates engineering work by calling `create_workstream` (which spawns an orchestrator). Cannot write code, run tests, or modify files.

### Orchestrator agent
Scoped to a single workstream. Crafts prompts for and manages Claude Code sessions that do the actual coding. Gets workstream-specific context injected into its system prompt. Cannot write code directly — delegates to Claude Code.

## Custom Tools

Registered by `runtime.createCustomTools(role, workstreamId?)` and passed through `createAutonomaAgent()` → Pi SDK's `createAgentSession()`.

### Shared (both roles)

| Tool | What it does |
|------|-------------|
| `query_blackboard` | Read-only SQL (SELECT/PRAGMA) against blackboard SQLite; returns JSON rows |
| `reload_resources` | Hot-reload skills, extensions, prompts, context files, and system prompt from disk |

### Default only

| Tool | What it does |
|------|-------------|
| `create_workstream` | Insert workstream row, spawn orchestrator session, optionally enqueue initial message with workstream-prefixed context |
| `enqueue_message` | Send a message to an existing orchestrator — validates workstream is open and orchestrator is running, enqueues with `[Workstream: "name" (id)]` prefix, persists to blackboard |

### Orchestrator only

| Tool | What it does |
|------|-------------|
| `create_worktree` | Create isolated git worktree branched from `origin/main`; record paths on workstream row |
| `close_workstream` | Human-gated. Clean up git worktree, close workstream row, broadcast `workstreams_changed`, end orchestrator session |

### Standard SDK tools (both roles)

`read`, `bash`, `grep` — provided by the Pi SDK via `createAgentSession()`, not custom tools.

## Session Lifecycle

1. **Creation**: `createDefault()` / `createOrchestrator()` calls `createAutonomaAgent()`, which wires up Pi SDK auth (`~/.pi/agent/`), model config, resource loader, and standard + custom tools. Session is persisted to `pi_sessions` table.
2. **Event subscription**: `subscribeToPiSession()` bridges Pi SDK events (`message_update`, `message_end`, `tool_execution_start/end`, `turn_end`) to WebSocket broadcasts. Assistant messages are deferred until `turn_end` (intermediate vs. final).
3. **State tracking**: `PiSessionState` tracks message count, last prompt/event timestamps, busy flag, current queue item.
4. **Orchestrator teardown**: `destroyOrchestrator()` stops the queue, unsubscribes events, disposes the Pi session, marks it ended/crashed in SQLite.
5. **Rehydration**: on startup, open workstreams from SQLite trigger `createOrchestrator()` for each, restoring the multi-session topology.

## TurnQueue

FIFO queue per session ensuring one turn processes at a time. Items carry: source, text, metadata, images, optional workstream context, delivery mode. The `pump()` loop drains sequentially; `steer` items bypass when the queue is busy and the session is streaming.

## Hook Integration

The runtime's `handleHook()` processes Claude Code session lifecycle events (`session-start`, `stop`, `session-end`). On `stop`, it extracts the last assistant message from the CC transcript and enqueues it back to the owning Pi session — closing the Pi→CC→Pi feedback loop. Sessions are matched by `pi_session_id`, `workstream_id`, or worktree path.

## Prompt Construction

System prompts built by `src/prompts/`:
- `buildDefaultAgentPrompt(piSessionId)` — triage role, workstream creation guidance
- `buildOrchestratorPrompt({workstreamName, workstreamId, repoPath, piSessionId})` — session orchestration, wave management, Claude Code delegation
- `buildClassificationPrompt(...)` — routes inbound messages to existing workstreams or default

Per-turn prompt: `formatPromptWithContext(item, role)` — currently returns `item.text` as-is.

## Key Files

| File | Purpose |
|------|---------|
| `src/runtime.ts` | `createCustomTools()`, `enqueue()`, `resolveTargetSession()`, `processQueueItem()`, `handleHook()` |
| `src/pi/create-agent.ts` | `createAutonomaAgent()` — Pi SDK session assembly with auth, model, tools, prompts |
| `src/pi/session-manager.ts` | `PiSessionManager` — create/destroy/lookup sessions, buildWorkstreamPrompt |
| `src/pi/turn-queue.ts` | `TurnQueue` — FIFO with steer bypass |
| `src/pi/session-state.ts` | `PiSessionState` — per-session runtime metadata |
| `src/pi/subscribe.ts` | `subscribeToPiSession()` — Pi SDK events → WebSocket broadcast |
| `src/pi/history.ts` | `readPiHistory()` — parse session files for history API |
| `src/pi/format-prompt.ts` | `formatPromptWithContext()` — per-turn prompt formatting |
| `src/prompts/default-agent.ts` | Default agent system prompt |
| `src/prompts/orchestrator.ts` | Orchestrator system prompt |
| `src/prompts/classifier.ts` | Message classification/routing prompt |
| `src/routes/browser-pi.ts` | `/api/pi/history` endpoint |
| `src/contracts/blackboard.ts` | `PiSessionStatus`, `pi_sessions` table schema |
| `src/contracts/control-surface-api.ts` | `PiRuntimeStatus`, `PiMultiSessionStatus`, history types |

## Dependencies

- **Blackboard** — SQLite persistence for sessions, workstreams, messages
- **Pi SDK** (`@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`) — model access, session management, standard tools, resource loading
- **WebSocket hub** — real-time event streaming to browser clients

## Observations

*Resolved:* Steer bypass in `runtime.enqueue()` now delivers directly via `session.prompt()` with `streamingBehavior: "steer"` whenever the queue is busy, regardless of streaming state. The `isStreaming` guard was removed.

*Resolved:* `enqueue_message` and `create_workstream` initial messages now use `source: "agent"` instead of `"web"`. Added `"agent"` to `MessageSource`, `UnifiedMessageSource`, and the `messages` table CHECK constraint (migration v11).

*Resolved:* `"pi_outbound"` added to `MessageSource` union; `as any` cast removed from `persistOutboundMessage` call.

*Resolved:* `formatPromptWithContext()` — removed unused `_role` parameter, updated all call sites.

*Resolved:* `ManagedPiSession.session` typed as `AgentSession` (from `@mariozechner/pi-coding-agent`). `customTools` typed as `unknown[]` through the chain, with an explicit cast to `ToolDefinition[]` at the SDK boundary in `createAutonomaAgent()`. A local `CustomToolDefinition` type in `runtime.ts` captures the plain-JSON-Schema tool shape.

*Resolved:* `enqueue_message` tool wraps `orchestrator.queue.enqueue()` in try/catch, returning a clean error message if the queue is stopped.
