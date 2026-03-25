# Autonoma — Features Overview

Orchestration layer above Claude Code. A long-running control surface hosts concurrent Pi agent sessions — one default for triage, one orchestrator per active workstream — behind a Groq classifier. State in SQLite; user interaction via WhatsApp and web client (bidirectionally synced); Claude Code sessions report back via hooks; OS-level cron injects periodic health checks.

## How It Works

### Message Flow

All inbound messages hit the control surface. Web and WhatsApp messages pass through a Groq classifier (`openai/gpt-oss-120b`) that matches against open workstreams in SQLite plus known project directories. Hook events and cron prompts bypass classification.

Routing after classification:
- **Matched workstream** → that workstream's orchestrator
- **New workstream needed** → default agent (can call `create_workstream` to spawn orchestrator)
- **Non-work / no match** → default agent
- **Hook events** → Pi session owning the Claude Code session (by `pi_session_id`, `workstream_id`, worktree path, or default fallback)
- **Cron** → default agent

Each Pi session has its own FIFO turn queue; all agents process concurrently.

### Workstream Lifecycle

Default agent creates workstreams via `create_workstream` — inserts SQLite row, spawns a bound orchestrator, and automatically passes through the original user message. The orchestrator enriches it (repo, git worktree via `create_worktree`), launches Claude Code sessions in tmux, coordinates waves through prompt-based delegation. On completion, `close_workstream` merges to main, pushes to origin, removes the worktree, closes the row, and self-destructs the orchestrator.

Soft-deleted: `status` flips to `closed` with `closed_at`. Classifier sees recently closed workstreams (24h) to prevent duplicates and allow reopening.

### Claude Code Feedback Loop

Hook scripts POST lifecycle events (`session-start`, `stop`, `session-end`) to the control surface. `session-start` registers the session in SQLite with Pi/workstream linkage. `stop` extracts the last assistant message from the transcript and enqueues it back to the owning Pi — closing the Pi → CC → Pi loop. `session-end` marks the session ended.

### Output Surfacing

Pi's final text each turn auto-surfaces to WhatsApp and web — no tool call needed. Web messages mirror to WhatsApp (`*User (web):*` prefix); Pi responses appear as `*B-bot:*`. Replies from either surface reach both.

### Proactive Behavior (Cron)

OS-level timer (systemd on Linux, launchd on macOS, 10-min interval) POSTs to `/cron/tick`. The endpoint runs a 6-gate sequence:

1. Pi session ready — default session exists
2. Pi not busy — no duplicate prompts
3. Pi session object exists — not ended/crashed
4. WhatsApp connected — Pi can reach user
5. No active circuit breakers (`health_flags`)
6. Stale sessions → stale-check prompt; no working sessions → idle-check prompt

Separate 60s maintenance loop: pings blackboard, refreshes WhatsApp, marks stale sessions, kills 24h-old idle tmux sessions, detects stuck turns (sets `stuck_turn` health flag, 30-min TTL, WhatsApp alert).

## Architecture

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│   Web App    │  │  WhatsApp    │  │  Cron Timer  │
│  (browser)   │  │  Daemon      │  │  (OS-level)  │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │ WS / HTTP        │ HTTP POST       │ HTTP POST
       ▼                  ▼                 ▼
┌───────────────────────────────────────────────────────────┐
│                Control Surface (:18820)                    │
│                                                           │
│  ┌───────────────────┐  Hook events ─────┐               │
│  │ Classifier (Groq) │  Cron prompts ────┤               │
│  │ Routes web/WA to  │                   │               │
│  │ workstream or     │                   │               │
│  │ default           │                   │               │
│  └────────┬──────────┘                   │               │
│           ▼                              ▼               │
│  ┌────────────────────────────────────────────────────┐  │
│  │              PiSessionManager                      │  │
│  │  Default agent (always-on singleton)               │  │
│  │  Orchestrators (per-workstream, ephemeral)         │  │
│  │  Each: TurnQueue · PiSessionState · Pi SDK session │  │
│  └────────────────────────────────────────────────────┘  │
│                                                           │
│  Blackboard (SQLite, WAL)  ·  WebSocketHub (RFC 6455)    │
│  Maintenance loop (60s)    ·  Bearer-token auth           │
└────────────────────┬──────────────────────────────────────┘
                     │
    ┌────────────────┼────────────────┐
    ▼                ▼                ▼
┌──────────┐  ┌──────────────┐  ┌─────────────────────┐
│ WhatsApp │  │  Blackboard  │  │ Claude Code (tmux)  │
│ Daemon   │  │  SQLite DB   │  │ Git Worktrees       │
│(Baileys) │  │  (v12)       │  │ Hook → POST         │
└──────────┘  └──────────────┘  └─────────────────────┘
```

## Components

### Control Surface

Node.js/TypeScript server on `127.0.0.1:18820`. Hosts `PiSessionManager`, Groq classifier, HTTP/WS API, maintenance loop. Single user, localhost only. Read-only `/api/*` unauthenticated; mutating endpoints require bearer token (auto-generated UUID).

Endpoints: `POST /message`, `/hook/:event`, `/cron/tick`, `/stop`, `/sessions/:id/message` (tmux inject), `/runtime/whatsapp/start|stop`; `GET /status`, `/api/sessions[/:id[/transcript]]`, `/api/pi/history`, `/api/skills`; `WS /ws`.

### Pi Agents

Two roles with tailored system prompts and role-gated tools:

**Default** — always-on triage. Delegates engineering work via `create_workstream` (spawns orchestrator, auto-passes original user message); sends messages to orchestrators via `enqueue_message`. Cannot write code.

**Orchestrators** — ephemeral, one per workstream. Manage Claude Code sessions. Tools: `create_worktree` (Git Town first, raw git fallback), `close_workstream` (merge, push, cleanup, self-destruct). Cannot write code directly.

Shared: `query_blackboard` (read-only SQL), `reload_resources` (hot-reload). SDK-provided: `read`, `bash`, `grep`.

Delivery: `followUp` (queue append) or `steer` (bypass queue, interrupt via `streamingBehavior: "steer"`; two-layer bypass at runtime and TurnQueue level).

On startup: creates default agent, rehydrates orchestrators for open workstreams. Crashed orchestrators auto-destroyed.

### Blackboard (SQLite)

`~/.autonoma/blackboard.db` — WAL, 5s busy timeout, foreign keys. Schema v12 (migrations v0→v12). Schema + row types + enums in `src/contracts/blackboard.ts`.

| Table | Purpose |
|-------|---------|
| `workstreams` | Units of work (open/closed), repo/worktree paths |
| `sessions` | Claude Code sessions: working → idle → stale → ended; linked to workstream + pi_session |
| `pi_sessions` | Pi runtime sessions: active / waiting_for_user / waiting_for_sessions / ended / crashed |
| `messages` | Unified log (TEXT UUID PK); sources: whatsapp, web, hook, cron, init, agent, pi_outbound |
| `message_id_map` | Agent message ID → server UUID bridging for deduplication |
| `whatsapp_messages` | Delivery tracking (pending → sent → delivered \| failed), reply matching |
| `pending_actions` | Persistent user decisions: whatsapp_auth_expired, restart_session, approve_change, clarify |
| `health_flags` | Circuit-breaker flags with optional TTL |

Code: `query-*.ts` (reads), `write-*.ts` (mutations), `pi-sessions.ts` (adapter). No barrel file.

### WhatsApp Channel

Standalone Baileys daemon, detached process, Unix domain socket IPC (newline-delimited JSON). Control surface auto-starts on first command.

Outbound: DB record → typing indicator → send → mark sent/failed; delivery receipts → `delivered`. Inbound: unwrap wrappers → extract text/caption → echo filter (5s) → dedup (`wa_message_id`) → forward HTTP → persist. Reply matching: quoted message → latest pending action → latest outbound with context_ref.

Auth: QR or pairing code; credentials backed up on every update; expiry creates `whatsapp_auth_expired` pending action. Single recipient, text-only.

### Web App

Thin browser client. TanStack Start (SSR + file-based routing), Tailwind v4 (oklch), Lit components for chat (`@mariozechner/pi-agent-core`), `marked` + `highlight.js`.

Routes: `/` (Input Surface), `/pi` (agent tabs: default + orchestrators), `/sessions` (list, 10s poll), `/sessions/$id` (detail + paginated transcript), `/runtime` (status, 5s poll).

Three `useSyncExternalStore` stores: `PiSessionStore` (per-session accumulators), `SettingsStore` (localStorage), WebSocket client (auto-reconnect with exponential backoff, heartbeat ping/pong, visibility-aware reconnect, circuit breaker).

Features: skill picker (`cmdk`), image attachments (paste/drop/pick, base64), followUp/steer modes, origin badges, light/dark/system theme, WhatsApp controls. WS subscription filtering: clients subscribe to session IDs; server filters `broadcast()` per-subscription. WS events use server-assigned UUIDs for message deduplication; ping/pong heartbeat for connection health.

### Installer

Two standalone ESM scripts (`install.mjs`, `uninstall.mjs`), zero dependencies (`node:*` only). Deploys `~/.autonoma/`, bootstraps config, installs Claude Code hooks in `~/.claude/settings.json`, optionally installs OS scheduler. Every change manifest-tracked (SHA-256 checksums, drift detection). Each step shows diff, requires confirmation.

Runtime tree: hook dispatcher (`hook-post.mjs`), process manager (`autonoma-up` — PID tracking, health checks, graceful shutdown cascade), WhatsApp CLI (`autonoma-wa`), cron script, shared shell utilities.

## Source Organization

Domain-organized, max 2-level nesting (`src/domain/file.ts`):

```
src/
├── blackboard/      # SQLite wrapper, migrations, query-*/write-*
├── classifier/      # Groq LLM routing
├── claude-sessions/ # Tmux inspection + injection
├── config/          # AutonomaConfig loader
├── contracts/       # Shared types, schema DDL, enums (SSOT), message.ts
├── custom-tools/    # close-workstream, create-worktree
├── pi/              # Session manager, turn queue, state, agent creation
├── prompts/         # System prompts (default, orchestrator, classifier)
├── routes/          # One file per endpoint
├── transcript/      # Paginated reader
├── whatsapp/        # Daemon, IPC, auth, send, receive, CLI
├── ws/              # WebSocketHub (raw RFC 6455)
├── runtime.ts       # ControlSurfaceRuntime
└── server.ts        # HTTP server, route dispatch, WS upgrade
```

## Features

| # | Feature | Purpose |
|---|---------|---------|
| 1 | [Installer / Uninstaller](installer/FEATURE.md) | Permission-gated, manifest-tracked deployment of runtime tree and external config modifications |
| 2 | [Blackboard](blackboard/FEATURE.md) | SQLite state layer (v12). Workstreams, Claude Code sessions, Pi sessions, unified messages, message ID mapping, WhatsApp tracking, pending actions, health flags |
| 3 | [Control Surface](control-surface/FEATURE.md) | HTTP/WS server hosting PiSessionManager (default + orchestrators), Groq classifier, maintenance loop |
| 4 | [WhatsApp Channel](whatsapp-channel/FEATURE.md) | Bidirectional Baileys daemon with IPC, echo/dedup filtering, reply matching, auth lifecycle |
| 5 | [Web App](web-app/FEATURE.md) | Browser client: Pi chat (two surfaces), session dashboard, paginated transcripts, direct messaging, runtime controls |
| 6 | [Cron Scheduler](cron-scheduler/FEATURE.md) | OS-level timer → health-gated periodic prompt injection for stale/idle session management |
| 7 | [Pi Agent](pi-agent/FEATURE.md) | Multi-agent Pi layer: default triage + per-workstream orchestrators with role-gated custom tools |
| 8 | [WebSocket Filtering](ws-subscription-filtering/FEATURE.md) | Per-client session subscriptions with server-side broadcast filtering |
| 9 | [Restructure src/](restructure-src/FEATURE.md) | Domain-organized codebase with max 2-level nesting, prefix conventions, barrel exports |

## Dependency Order

```
Installer → Blackboard → WhatsApp Channel ──┐
                                             ├─→ Control Surface (+ Classifier)
                                   (none) ──┘            → Web App
                                                         → Cron Scheduler
```

## State Glossary

### Claude Code sessions

`working` → `idle` → `stale` → `ended`. No persisted `crashed`; unlaunched sessions have no row. Staleness: `last_event_at` > `stallMinutes` (15) AND no tool activity past `toolTimeoutMinutes` (60); marked by maintenance loop.

### Pi sessions

`active` (processing turn) · `waiting_for_user` (universal idle) · `waiting_for_sessions` (CC sessions running) · `ended` · `crashed`. All transitions runtime-managed.

### Workstreams

`open` (active, optional repo/worktree) · `closed` (soft-deleted with `closed_at`; visible to classifier for 24h).

## Design Principles

- **Multi-agent, single runtime** — one process, concurrent Pi sessions with independent turn queues
- **Classifier routes, Pi acts** — Groq matches to workstreams; hooks and cron bypass classification
- **Workstreams are the unit of work** — each gets a worktree, CC sessions, dedicated orchestrator that self-destructs on completion
- **Unified comms** — Pi responses auto-surface to WhatsApp + web; messages from either surface mirror to both
- **Push-based** — all delivery event-driven; no polling for message discovery
- **Delivery before bookkeeping** — forward first, persist in try/catch after
- **Prompt-driven waves** — Pi coordinates CC session waves through instructions, not infrastructure
- **Todoist is human-owned** — Pi reads/annotates, never autonomously completes
- **Permission-gated** — Pi suggests, doesn't execute without approval
- **Minimal footprint** — only `~/.claude/settings.json` and scheduler entries touched outside `~/.autonoma/`
- **Uninstaller-first** — manifest-tracked, drift-detected removal before installation

## Quick Start

```bash
pnpm install
pnpm --dir web install
node .autonoma/install.mjs
~/.autonoma/bin/autonoma-up start
# optional
pnpm --dir web dev
~/.autonoma/bin/autonoma-wa auth
```
