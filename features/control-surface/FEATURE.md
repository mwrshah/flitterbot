# Feature: Control Surface

Long-running Node.js/TypeScript server — Autonoma's central nervous system. Hosts multiple concurrent Pi agent sessions (one default + per-workstream orchestrators), routes inbound events through a Groq-based classifier, and lets Pi act on the world through custom tools, skills, and auto-surfaced replies.

## Problem

Without a control surface, every channel (WhatsApp, hooks, cron, web) needs its own agent session. Pi cold-starts constantly, loses continuity, and can't work across workstreams concurrently.

## Architecture

```
              ┌──────────────────────────────────────────────────────┐
              │                  Control Surface                     │
              │                                                      │
              │  HTTP / WS API (:18820, localhost only)              │
              │  ├─ POST /message         ← Web, cron, daemon       │
              │  ├─ POST /hook/:event     ← Claude Code hooks       │
              │  ├─ POST /cron/tick       ← Scheduled maintenance   │
              │  ├─ POST /stop            ← Graceful shutdown       │
              │  ├─ GET  /status          ← Health (open)           │
              │  ├─ GET  /api/sessions    ← Session browser (open)  │
              │  ├─ GET  /api/pi/history  ← Pi history (open)       │
              │  ├─ GET  /api/skills      ← Loaded skills (open)    │
              │  ├─ POST /runtime/whatsapp/start|stop               │
              │  ├─ POST /sessions/:id/message  ← Direct inject     │
              │  └─ WS   /ws             ← Real-time events         │
              │                                                      │
              │  ┌────────────────────────────────────────────────┐  │
              │  │ PiSessionManager                              │  │
              │  │  ├─ Default agent (always-on, one instance)   │  │
              │  │  └─ Orchestrators (per-workstream, ephemeral) │  │
              │  │     Each has: TurnQueue · PiSessionState ·    │  │
              │  │     Pi agent session · WebSocket subscription  │  │
              │  └────────────────────────────────────────────────┘  │
              │                                                      │
              │  Classifier (Groq) → route message to workstream    │
              │  Blackboard (SQLite) → persistent state             │
              │  WebSocketHub → broadcast events to web clients     │
              └──────────────┬───────────────────────────────────────┘
                             │
           ┌─────────────────┼─────────────────────┐
           ▼                 ▼                      ▼
  ┌─────────────────┐ ┌──────────────┐  ┌───────────────────┐
  │ WhatsApp Daemon │ │ Blackboard   │  │ Claude Code tmux  │
  │ (Baileys)       │ │ (SQLite)     │  │ sessions          │
  └─────────────────┘ └──────────────┘  └───────────────────┘
```

## Multi-Agent Model

`PiSessionManager` manages two roles:

**Default agent** — always-on singleton. Handles non-work messages and meta-operations. Has `create_workstream` tool. Receives raw user text (context header injection is stubbed but not yet implemented — see Observations).

**Orchestrators** — ephemeral, one per active workstream. Spawned on classifier match. Has `create_worktree`, `close_workstream`, `enqueue_message` tools. Receives raw user text. Self-destructs on workstream close: kill CC sessions, merge branch, push, clean up.

Shared tools: `query_blackboard`, `reload_resources`, `read`, `bash`, `grep`, plus skills (Todoist, tmux-2).

Each `ManagedPiSession` bundles: agent session, `TurnQueue` (FIFO + steer-interrupt), `PiSessionState`, role, workstream binding, WebSocket subscription.

## Message Flow

1. **Inbound**: WhatsApp/web/hook/cron → HTTP endpoint → `runtime.enqueue()`
2. **Classify**: Groq classifier matches web/WhatsApp messages to open workstreams (or "none")
3. **Route**: matched → orchestrator queue; new workstream → spawn orchestrator; non-work → default agent
4. **Process**: `TurnQueue.pump()` → `processQueueItem()` → `session.prompt()` — per-session queues, so all agents run concurrently
5. **Output**: Pi's final text auto-surfaces to WhatsApp (IPC) + web clients (`pi_surfaced` WS event)

### Delivery Modes

`followUp` appends to queue normally. `steer` bypasses queue and interrupts the current turn — for urgent redirects.

### Event Sources

| Source | Transport | Endpoint |
|--------|-----------|----------|
| WhatsApp | Daemon HTTP forward | POST /message |
| Web app | WebSocket or HTTP | POST /message |
| Claude Code hooks | Hook script POST | POST /hook/:event |
| Cron | systemd/launchd timer | POST /cron/tick |

## Blackboard (SQLite)

`~/.autonoma/blackboard.db` — persistent state. Tables:

- **workstreams** — id, name, status, repo, worktree path, closed_at (soft-delete with 6h visibility window)
- **sessions** — Claude Code sessions with pi_session_id linkage, status, tmux/cwd/model metadata
- **pi_sessions** — Pi runtime state mirror (status, model, session file path, prompt/event timestamps)
- **messages** — inbound/outbound message log with source, workstream binding
- **whatsapp_messages** — WhatsApp-specific message tracking (wa_message_id, direction, status)
- **health_flags** — circuit breakers for maintenance gating
- **pending_actions** — queued actions

Key enums: `ClaudeSessionStatus` (working/idle/stale/ended), `PiSessionStatus` (active/waiting_for_user/waiting_for_sessions/ended/crashed), `WorkstreamStatus`.

## Hook Event Handling

POST `/hook/:event` — runtime filters before forwarding to Pi:

- **SessionStart**: only `agent_managed=true` or Pi's own session; others filtered
- **Stop/SessionEnd**: only sessions already in blackboard; unknown filtered

Accepted hooks update blackboard and enqueue to the relevant Pi session (via `pi_session_id`).

## Cron Tick

POST `/cron/tick` — gated on: Pi not busy, session exists, WhatsApp connected, no circuit breakers. Marks stale CC sessions; enqueues stale-check or idle-check prompt.

## Custom Tools

| Tool | Role | What It Does |
|------|------|-------------|
| `query_blackboard` | both | Read-only SQL against blackboard.db (SELECT/PRAGMA only) |
| `reload_resources` | both | Hot-reload skills, extensions, prompts, system prompt |
| `create_workstream` | default | Register new workstream; triggers orchestrator spawn |
| `create_worktree` | orchestrator | Git worktree creation (NNN-slug branch naming, git-town integration) |
| `close_workstream` | orchestrator | Kill CC sessions, merge branch to main, push, close workstream, end Pi session |
| `enqueue_message` | orchestrator | Send message to another Pi session (cross-session communication) |

## WebSocket

`WebSocketHub` — raw RFC 6455 (no library). Clients subscribe to session IDs or `*` (wildcard). Events: `text_delta`, `message_end`, `tool_execution_start/end`, `turn_end`, `pi_surfaced`, `workstreams_changed`, `status_changed`, `queue_item_start/end`.

## HTTP API

**Read-only (unauthenticated, localhost):** GET /api/sessions, /api/sessions/:id, /api/sessions/:id/transcript, /api/pi/history (`?surface=input|agent`, `?piSessionId=`), /api/skills

**Mutating (bearer auth):** POST /message, /hook/:event, /stop, /cron/tick, /sessions/:id/message (tmux inject), /runtime/whatsapp/start|stop

## WhatsApp Integration

Baileys daemon — separate process, control-surface-owned. Inbound: filtered (5s echo window, dedup), forwarded to /message. Supports conversation, extended text, image, video, document types. Outbound: auto-surfaced replies via daemon IPC.

## Session Persistence

JSONL on disk with auto-compaction. `pi_sessions` SQLite table mirrors runtime state. On startup, `PiSessionManager` reconciles previous sessions and creates the default agent.

## Key Source Files

```
src/control-surface/
├── server.ts              # HTTP server, route dispatch, WebSocket upgrade
├── runtime.ts             # ControlSurfaceRuntime — main orchestrator class
├── config/
│   └── load-config.ts     # AutonomaConfig (23 props from ~/.autonoma/config.json + env)
├── contracts/
│   ├── control-surface-api.ts  # All request/response types, endpoint definitions
│   ├── blackboard.ts           # Schema DDL, row types, status enums
│   ├── websocket.ts            # Client/server WebSocket event types
│   └── tmux-bridge.ts          # Tmux inspection + session launch types
├── pi/
│   ├── session-manager.ts      # PiSessionManager — default + orchestrator lifecycle
│   ├── turn-queue.ts           # TurnQueue — FIFO with steer-interrupt
│   ├── session-state.ts        # PiSessionState — mutable runtime snapshot
│   ├── create-agent.ts         # createAutonomaAgent() — spawn Pi with tools/skills
│   ├── format-prompt.ts        # formatPromptWithContext() — stub, currently pass-through
│   ├── subscribe.ts            # subscribeToPiSession() — event → WebSocket bridge
│   └── history.ts              # readPiHistory() — parse JSONL session files
├── routes/                     # One file per endpoint (message, hooks, cron-tick, etc.)
├── ws/
│   └── hub.ts                  # WebSocketHub — raw RFC 6455, subscriptions, broadcast
├── blackboard/
│   ├── db.ts                   # SQLite wrapper (WAL mode)
│   ├── query-*.ts / write-*.ts # Per-table query/write functions
│   └── migrate.ts              # Schema versioning
├── custom-tools/
│   ├── create-worktree.ts      # Git worktree creation
│   ├── close-workstream.ts     # Workstream finalization (merge, push, cleanup)
│   └── manage-session.ts       # Direct CC session messaging via tmux
├── classifier/
│   ├── classify.ts             # classifyMessage() — Groq LLM routing
│   └── groq-client.ts          # Groq API client
├── prompts/
│   ├── default-agent.ts        # Default agent system prompt
│   ├── orchestrator.ts         # Orchestrator system prompt
│   └── classifier.ts           # Classifier prompt
├── whatsapp/                   # Daemon lifecycle, send/receive, auth, IPC, config
├── claude-sessions/            # Tmux inspection + message injection
└── transcript/                 # Paginated transcript reading
```

## Runtime Files

| Path | Purpose |
|------|---------|
| `~/.autonoma/config.json` | Port, tokens, thresholds, model, WhatsApp config |
| `~/.autonoma/blackboard.db` | SQLite (WAL mode) |
| `~/.autonoma/control-surface/sessions/` | Pi session JSONL files |
| `~/.autonoma/control-surface/agent/` | Pi prompt, skills, extensions, auth/models |
| `~/.autonoma/logs/control-surface.log` | Server log |
| `~/.autonoma/whatsapp/` | Auth data, daemon PID, IPC socket |
| `~/.autonoma/hooks/hook-post.mjs` | Claude Code hook script |

## Design Decisions

- **Multi-agent, single runtime.** One process, multiple concurrent Pi sessions — default for meta-ops, orchestrators for workstreams.
- **Groq classifier as router.** Cheap/fast LLM classifies messages to workstreams before reaching Pi — deterministic routing, clean context.
- **Per-session turn queues.** Each session's own queue; orchestrators run concurrently with each other and the default agent.
- **HTTP on loopback.** Bearer token for mutations; read-only unauthenticated.
- **WhatsApp daemon separate, app-owned.** Transport process only; control surface owns lifecycle.
- **Orchestrator self-close.** `close_workstream` finalizes the workstream (merge, push, cleanup) and self-destructs.
- **Workstream soft-delete.** 6h visibility window after close — router and Pi retain recent context.
- **Raw WebSocket.** `WebSocketHub` implements RFC 6455 directly — no library.

## Constraints

- Single user, single server, localhost only
- Bearer-token auth (auto-generated UUID) for mutations; read-only /api/* unauthenticated
- Pi defaults to claude-opus-4-6 via Anthropic API; configurable

## Observations

- **TBD!** `formatPromptWithContext()` in `src/pi/format-prompt.ts` is a no-op — returns `item.text` unchanged, ignores the `_role` parameter. The `<context source="..." workstream="..." />` XML header injection (spec-03-clean-pi-messages) was never implemented. Default agent receives raw text identical to orchestrators; no structured metadata distinguishes message source or workstream context at the prompt level.
