# Autonoma — Features Overview

Orchestration layer above Claude Code. A long-running control surface hosts a single embedded Pi agent behind a stateless message router, manages workstreams and their Claude Code sessions in SQLite, and communicates with the user over WhatsApp and a web client — both primary surfaces with bidirectional sync.

## What it does

Every inbound message (WhatsApp or web client) passes through a stateless router (Gemini Flash Lite) that classifies it against open workstreams stored in SQLite, plus a directory listing of known projects. The router assigns the message to an existing workstream, creates a new workstream row (with a name it derives from the message), or passes null for non-work messages. It then forwards the message with workstream context to the single embedded Pi agent running inside the control surface.

Pi receives messages tagged with workstream context and acts accordingly: creating git worktrees for workstreams that involve code changes, launching Claude Code sessions in tmux (tagged to the workstream), and managing wave execution through prompt-based coordination. When Pi enriches a workstream (choosing the repo, creating the worktree), it writes the repo path and worktree path back to the workstream row.

Claude Code sessions report lifecycle events via hooks that POST to the control surface. When a session completes, Pi is notified and decides whether to launch follow-up work, wait for other sessions in the wave, or notify the user. Pi's final text response each turn is automatically extracted by the runtime and pushed to both WhatsApp and the web client simultaneously — no explicit tool call needed.

Pi is reactive in v1 — triggered by human messages and Claude Code hook events. There is no cron-driven proactive behavior yet. Pi can read Todoist when asked and annotate tasks, but never autonomously completes them. Workstream rows are ephemeral — created by the router, enriched by Pi, and deleted by Pi when the workstream is done (along with git worktree cleanup).

## Architecture

```
┌──────────────┐                         ┌──────────────┐
│   Web App    │                         │  Hook Scripts │
│  (browser)   │                         │  (cc events)  │
└──────┬───────┘                         └──────┬────────┘
       │ WS / HTTP                              │ HTTP POST
       ▼                                        │
┌──────────────────────────────────────────────────────────┐
│               Control Surface (:18820)                  │
│                                                          │
│  ┌─────────────────────┐   Hook events bypass router,    │
│  │ Router              │   feed directly to Pi ─────┐    │
│  │ (Gemini Flash Lite) │                            │    │
│  │ Classifies inbound  │                            │    │
│  │ messages against    │                            │    │
│  │ open workstreams    │                            │    │
│  └─────────┬───────────┘                            │    │
│            │ msg + workstream ctx                   │    │
│            ▼                                        ▼    │
│  ┌──────────────────────────────────────────────┐        │
│  │           Embedded Pi Agent (SDK)            │        │
│  │  Persistent session · auto-compacting        │        │
│  │  Serialized turn queue                       │        │
│  │  Tools: query_blackboard, close_workstream,  │        │
│  │         reload_resources, read, bash, grep   │        │
│  │  Skills: Todoist, tmux-2, Autonoma workflows │        │
│  └──────────────────────────────────────────────┘        │
│                         │                                │
└─────────────────────────┼────────────────────────────────┘
             ┌────────────┼────────────┐
             ▼            ▼            ▼
    ┌────────────┐ ┌──────────────┐ ┌──────────────────────┐
    │  WhatsApp  │ │  Blackboard  │ │ Claude Code (tmux)   │
    │  Daemon    │ │   SQLite     │ │  Git Worktrees       │
    │ (Baileys)  │ │              │ │  Hook → POST         │
    └────────────┘ └──────────────┘ └──────────────────────┘
```

## Features

| # | Feature | Purpose |
|---|---------|---------|
| 1 | [Installer / Uninstaller](installer/FEATURE.md) | Permission-gated, manifest-tracked modification of external configs. Uninstaller-first. |
| 2 | [Blackboard](blackboard/FEATURE.md) | SQLite state layer. Tracks workstreams, Claude Code sessions (linked to workstreams), Pi runtime sessions, events, messages, and pending actions. |
| 3 | [Control Surface](control-surface/FEATURE.md) | HTTP server hosting the embedded Pi agent and stateless message router. Central hub: all channels push events in, router classifies, Pi acts through tools and skills. |
| 4 | [WhatsApp Channel](whatsapp-channel/FEATURE.md) | Bidirectional Baileys messaging. Daemon maintains connection; forwards inbound to control surface and stores history in the blackboard. |
| 5 | [Web App](web-app/FEATURE.md) | Browser client: chat with Pi, Pi session drill-down, Claude Code session drill-down with transcripts, direct session messaging, WhatsApp health indicator. |
| 6 | [Cron Scheduler](cron-scheduler/FEATURE.md) | *Deferred to post-v1.* Periodic state check and recovery loop. Will wake Pi for idle/stale classification and Todoist-driven work discovery once Pi has orchestration logic. |
| 7 | [Pi Agent Tools](pi-agent/FEATURE.md) | Custom tools given to Pi agents, role-gated by type (default vs orchestrator). Covers query_blackboard, reload_resources, create_workstream, create_worktree, close_workstream, and new tool specs. |

## Dependency Order

```
Installer → Blackboard → WhatsApp Channel ──┐
                                             ├─→ Control Surface (+ Router)
                                   (none) ──┘            → Web App
```

Installer configures hooks. Blackboard needs installed hooks. WhatsApp daemon is a standalone transport that the control surface connects to. The control surface depends on the blackboard and WhatsApp daemon being available. The web app talks to the control surface.

## State Glossary

Canonical runtime terms used across the specs:

### Claude Code session states

- **`working`** — the session appears active and is still inferencing or otherwise advancing work
- **`idle`** — the session exists but is not currently doing work; this also covers "waiting for input"
- **`stale`** — the session stopped advancing long enough that SQLite now marks it suspect and Pi should verify real tmux state
- **`ended`** — the session is finished or has been intentionally reconciled closed

Notes:
- Claude does **not** use a separate persisted `crashed` state in v1
- a session that has never been launched usually has **no row yet** rather than a special `not_started` status

### Pi runtime states

- **inactive** — no active Pi runtime row currently exists
- **`active`** — Pi runtime exists and is processing a turn
- **`waiting_for_user`** — universal idle state. Covers: startup, between tasks, after finishing work, ball in user's court. Any time Pi isn't active and isn't waiting for sessions, it's waiting for the user.
- **`waiting_for_sessions`** — Pi is waiting for one or more managed Claude Code sessions to complete. When the last managed session stops, Pi transitions to `active` (processes the hook), then to `waiting_for_user`.
- **`ended`** — Pi runtime was intentionally closed
- **`crashed`** — Pi runtime was reconciled as abnormally terminated

Notes:
- All state transitions are runtime-managed — Pi never sets its own state
- `waiting_for_user` and `waiting_for_sessions` are tracked for observability in v1; cron will act on them post-v1
- Pi `crashed` is worth persisting because repeated abnormal exits are operationally useful to debug

### Workstream states

Workstreams are soft-deleted, not hard-deleted. Each workstream has a `status` field (`open` or `closed`) and a `closed_at` timestamp. When Pi completes a workstream (via the orchestrator's `close_workstream` tool), the row is set to `closed` and the git worktree is removed. The router sees recently closed workstreams (last 6 hours) to prevent duplicate creation and allow reopening.

## Design Principles

- **Single embedded Pi (v1)**: only the control surface hosts Pi. Future versions will support multiple orchestrator Pi agents per workstream.
- **Router classifies all inbound**: every human message passes through the stateless router before reaching Pi. Hook events bypass the router.
- **Workstreams are the unit of work**: Pi manages work through workstreams, each with its own git worktree and associated Claude Code sessions.
- **Unified comms**: Pi's final text response is automatically surfaced to WhatsApp and the web client by the runtime. Bidirectional sync — replies from either surface appear on both.
- **Wave execution is prompt-driven**: Pi coordinates Claude Code session waves through its instructions, not infrastructure. No wave table or completion counting in code.
- **Channels are transports**: WhatsApp, web app, and hooks all push events into the control surface. Context lives in Pi and the blackboard, never in the surface.
- **Pi is the brain**: orchestration intelligence lives in the embedded Pi session, not in disconnected wrappers.
- **Todoist is human-owned**: Pi reads Todoist when asked, can annotate tasks, but never autonomously completes them.
- **Permission-gated**: Pi suggests actions, doesn't execute significant changes without user approval.
- **Push-based, never poll**: all message delivery is event-driven. WhatsApp inbound pushes to the control surface via HTTP; Claude Code hooks push via HTTP; the web client pushes via WebSocket. No component polls a database or queue to discover new messages. Polling introduces unnecessary latency, coupling, and failure modes.
- **Delivery before bookkeeping**: the primary action (forwarding a message to its destination) must never be gated on secondary concerns (database writes, context enrichment, deduplication). Persist and enrich after delivery succeeds, inside a try/catch so failures are logged but never drop the message.
- **Minimal footprint**: only `~/.claude/settings.json` and systemd/launchd entries touched outside Autonoma's directory.
- **Uninstaller-first**: removal scripts before installation scripts.
- **Namespaced**: all Autonoma artifacts are identifiable for clean removal.

## Future Direction

The v1 single-Pi architecture is designed to evolve toward the full vision. The Pi lifecycle spec is now written and being implemented — the foundations for multi-Pi are actively being built:

- **Pi lifecycle (in progress)**: Pi→session linkage (`pi_session_id` FK on sessions), runtime-managed state machine (active/waiting_for_sessions/waiting_for_user/ended/crashed), orchestrator self-close via human-gated `close_workstream` tool.
- **Multi-Pi orchestration**: each workstream gets its own Pi agent (orchestrator), with a default agent handling non-workstream requests and Todoist-driven work discovery.
- **Router spawns orchestrators**: instead of just classifying, the router creates new orchestrator Pi instances with one-time context transfer.
- **Cron-driven proactivity**: Pi agents wake on cron to check Todoist, monitor sessions, and surface options to the user.
- **Skill Recursion Engine**: automated audit of Claude Code sessions for skill improvement proposals.

The v1 workstreams table, session-to-workstream binding, router classification, and Pi lifecycle machinery lay the schema and behavioral foundation for this evolution.

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
