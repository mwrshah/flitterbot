# Autonoma — Major Phases Plan

Implementation order for the v1 architecture:

- One long-running **control surface** with an embedded **Pi** session
- **Stateless router** (Gemini Flash Lite) classifying inbound messages against open workstreams
- SQLite **blackboard** as shared state, including workstreams and session-to-workstream binding
- **WhatsApp** as a transport daemon owned by app runtime
- **Web app** as a browser client with chat, session drill-down, and transcript viewing
- **Git worktrees** per workstream for code isolation
- **Cron** deferred to post-v1 — Pi is reactive (human messages + hook events) until orchestration logic matures

Goal: minimize rework, maximize safe parallel execution, reach usable state fastest.

## Guiding Rules

1. **Build the runtime spine first.** Control surface, blackboard, router, and persisted Pi session are the core.
2. **Router is a classifier, not an orchestrator.** It reads workstreams from SQLite, classifies inbound messages, writes new workstream rows when needed, and passes everything to the single Pi with context.
3. **WhatsApp and web are co-primary surfaces.** Both receive all Pi outputs via unified `send_to_user` tool. Bidirectional sync: replies from either surface appear on both.
4. **Freeze interfaces before parallel work.** DB schema and control-surface API shape must stabilize early so UI/channel work proceeds safely.
5. **Simplest workable transport in v1.** Direct Claude session messaging uses tmux injection for now.
6. **Parallelize by interface ownership, not feature labels.** One owner per shared pathway.
7. **Cron is deferred.** Pi is reactive in v1 — triggered by human messages and Claude Code hook events. Cron recovery and proactive Todoist checking come after Pi has orchestration logic worth waking up for.

---

## Current State Snapshot

### Ready to implement

- **Blackboard** — `features/blackboard/FEATURE.md` + specs
- **Control Surface** — `features/control-surface/FEATURE.md` + specs
- **Installer** — `features/installer/FEATURE.md` + specs
- **Web App** — `features/web-app/FEATURE.md` + specs

### Implementable with baseline already proven locally

- **WhatsApp Channel** — `features/whatsapp-channel/FEATURE.md` + specs
  Baseline daemon/send/reply flow is considered proven locally. Remaining work is runtime ownership, control-surface integration, and operational hardening.

### Deferred

- **Cron Scheduler** — `features/cron-scheduler/FEATURE.md` + specs
  Deferred to post-v1. Will be implemented once Pi has orchestration prompts worth running on a schedule.

---

## Dependency Graph

```text
Installer
  ├──> Blackboard (+ workstreams table)
  └──> Runtime file deployment

Blackboard
  └──> Control Surface (+ Router)
         ├──> tmux / Claude session bridge + git worktrees
         ├──> WhatsApp daemon ownership
         └──> Web app client
```

Equivalent linear reading:

```text
Blackboard + runtime config (with workstreams)
  -> Control Surface core + Router
  -> tmux / Claude bridge + git worktrees
  -> WhatsApp transport integration
  -> web app client
  -> hardening
  -> (post-v1) cron recovery
```

---

# Major Phases

## Phase 1 — Blackboard and runtime foundation

**Goal:** Build the state and config substrate everything depends on — stable SQLite schema with workstream tracking, persisted runtime state, session/runtime lookup queries, predictable config loading.

**Scope:**
- SQLite init + migrations
- Blackboard schema: `sessions` (with `workstream_id` FK), `workstreams`, `pi_sessions`, `whatsapp_messages`, `pending_actions`
- `workstreams` table: `id`, `name`, `repo_path` (nullable, set by Pi), `worktree_path` (nullable, set by Pi), `created_at`
- Hook writer behavior (session insert/update on hook events)
- Launch metadata handshake
- Stale-reconciliation and idle-cleanup queries
- Config loader for `~/.autonoma/config.json`

**Suggested modules:**
- `src/config/load-config.ts`
- `src/blackboard/db.ts`, `migrate.ts`, `schema.sql`
- `src/blackboard/queries/sessions.ts`, `pi-sessions.ts`, `workstreams.ts`

**Exit criteria:** Schema implemented and migratable; workstreams table exists with session FK; hook writes durable and spec-aligned; `pi_sessions` queryable; control surface can safely depend on blackboard.

---

## Phase 2 — Control Surface core runtime + Router

**Goal:** Bring up the real app runtime: control surface with embedded Pi and stateless message router.

**Scope:**
- HTTP server
- Stateless router (Gemini Flash Lite): reads open workstreams from SQLite + `ls` of projects directory, classifies every inbound message, creates new workstream rows when needed, passes message + workstream context to Pi
- Embedded Pi with persisted JSONL session
- Single-turn FIFO queue
- Pi event subscriptions
- Pi state tracking: `active`, `idle`, `waiting_for_user`, `waiting_for_sessions`
- `pi_sessions` mirroring
- Routes: `/message` (through router), `/hook/:event` (bypasses router), `/status`, `/stop`
- Unified `send_to_user` tool: sends to WhatsApp + WS broadcast simultaneously
- Runtime lifecycle handling
- Basic custom-tool registration shells

**Modules:**
- `src/server.ts`, `runtime.ts`
- `src/classifier/classify.ts` (Gemini Flash Lite call)
- `src/pi/create-agent.ts`, `session-state.ts`, `subscribe.ts`
- `src/pi/turn-queue.ts`
- `src/routes/message.ts`, `hooks.ts`, `status.ts`, `stop.ts`
- `src/custom-tools/` (send-to-user, etc.)

**Exit criteria:** Control surface starts cleanly; router classifies inbound messages and manages workstream rows; embedded Pi persists across restarts; queue serializes turns; Pi state tracked; `/status` reports live Pi and open workstreams; hook and message ingress work; `send_to_user` pushes to both surfaces.

---

## Phase 3 — Claude/tmux bridge, git worktrees, and machine integrations

**Goal:** Connect runtime to real Claude Code sessions with git worktree isolation per workstream.

**Scope:**
- tmux/Claude session adapter
- Git worktree creation per workstream (Pi writes `repo_path` and `worktree_path` back to workstream row)
- Git worktree cleanup on workstream completion (Pi deletes worktree + workstream row)
- Direct session messaging endpoint
- Claude Code session launch and management via tmux-2 skill — sessions tagged with `workstream_id`
- Hook forwarding alignment
- Control-surface-side event filtering
- Browser-facing session/transcript endpoints

**Suggested modules:**
- `src/claude-sessions/tmux.ts`, `send-message.ts`, `launch-session.ts`
- `src/claude-sessions/worktree.ts` (create/cleanup git worktrees)
- `src/routes/direct-session-message.ts`, `browser-sessions.ts`, `browser-transcript.ts`

**Key v1 decision:** Direct Claude session messaging uses **tmux send-keys**, but only after an inject-safe state check; busy or ambiguous sessions fail closed.

**Exit criteria:** Control surface can list/inspect Claude sessions by workstream; git worktrees created and cleaned up with workstream lifecycle; direct message delivery works through the inject-safe gate; browser-facing session and transcript endpoints exist; hook routing reaches control surface cleanly.

---

## Phase 4 — WhatsApp transport integration

**Goal:** Connect app runtime to a real outbound/inbound user channel with bidirectional sync.

**Scope:**
- WhatsApp daemon process ownership by control surface
- Runtime endpoints: `/runtime/whatsapp/start`, `/runtime/whatsapp/stop`
- Inbound forwarding to control surface (through router)
- Outbound via `send_to_user` tool (sends to WhatsApp + WS simultaneously)
- Bidirectional sync: WhatsApp replies appear in web client via WS, web client replies appear in WhatsApp thread
- Outbound/inbound blackboard flow
- Manual auth flow (`autonoma-wa auth`)
- Web client WhatsApp health indicator (notification banner when WhatsApp disconnected)

**Suggested modules:**
- `src/whatsapp/daemon.ts`, `ipc.ts`, `auth.ts`, `send.ts`, `receive.ts`
- `src/routes/runtime-whatsapp.ts`

**V1 UX decision:** WhatsApp auth stays **manual and terminal-driven**.

**Exit criteria:** Control surface starts/stops daemon; `send_to_user` delivers to WhatsApp; inbound replies reach router and then Pi; bidirectional sync working between surfaces; web client shows WhatsApp connection status; manual auth documented and working.

---

## Phase 5 — Web app client

**Goal:** Browser client consuming stable backend contracts. Three primary views.

**Scope:**
- TanStack Start shell
- Localhost bearer-token fetch layer
- WS client for Pi streaming + bidirectional message sync
- **Chat view**: conversation with Pi, tool-event rendering
- **Pi session drill-down**: inspect the Pi agent session state, open workstreams, Pi state transitions
- **Claude Code session drill-down**: session list by workstream, session detail, transcript viewing
- Direct session messaging UI
- Runtime controls for WhatsApp daemon (start/stop, health status)
- WhatsApp disconnection notification banner

**Suggested modules:**
- `web/src/lib/api.ts`, `ws.ts`
- `web/src/routes/__root.tsx`, `index.tsx`, `sessions/index.tsx`, `sessions/$sessionId.tsx`
- `web/src/components/chat/ChatPanel.tsx`, `ToolEventList.tsx`
- `web/src/components/sessions/SessionList.tsx`, `SessionDetail.tsx`, `TranscriptViewer.tsx`
- `web/src/components/runtime/WhatsAppControls.tsx`
- `web/src/components/workstreams/WorkstreamList.tsx`

**Exit criteria:** Browser can chat with Pi, see workstream status, list sessions per workstream, inspect transcript previews, send direct Claude session messages, start/stop WhatsApp daemon, see WhatsApp health status.

---

## Phase 6 — Installer, startup wrappers, and hardening

**Goal:** Clean install/start/recover/uninstall lifecycle.

**Scope:**
- Installer/uninstaller finalization
- Runtime file deployment
- Startup wrapper cleanup, PID/log handling
- Graceful shutdown
- Transcript API normalization cleanup
- Runtime error handling and retries
- End-to-end install/run/recover/uninstall checks

**Exit criteria:** Install is idempotent; uninstall removes only Autonoma-owned modifications; startup wrapper reliable; hooks, web, and WhatsApp all converge on same control-surface Pi runtime; end-to-end smoke tests pass.

---

## Deferred — Cron recovery loop (post-v1)

**Goal:** Self-healing and proactive work discovery. Deferred until Pi has orchestration prompts that make periodic wake-ups valuable.

**Planned scope:**
- Cross-platform scheduling (launchd + Linux systemd user timer)
- SQLite-backed idle/stale classification
- Launch-if-missing, `/status` health check
- Todoist-driven work discovery: Pi checks for pending tasks and surfaces options to the user
- Act on Pi states: skip wake-up when `waiting_for_user`, trigger work discovery when `idle`
- Deterministic prompt injection after recovery

**Why deferred:** Without orchestration logic in Pi's prompt, cron would wake Pi with nothing to do. The proactive loop becomes valuable once Pi can check Todoist, assess workstream progress, and surface actionable options.

---

## Deferred — Multi-Pi orchestration (future)

The v1 architecture is designed to evolve toward multiple concurrent Pi agents:

- **Default agent** — always-on, handles non-workstream requests, checks Todoist, runs investigations, surfaces options
- **Workstream orchestrators** — one Pi per active workstream, each managing its own Claude Code sessions and git worktree
- **Router spawns orchestrators** — instead of just classifying, the router creates new Pi instances with one-time context transfer from the default agent
- **Session lifecycle** — `active → waiting_for_user → dormant → closed` with cron-driven state transitions

The v1 workstreams table, session-to-workstream FK, and router classification are the schema foundation for this evolution. The transition is a runtime change (multiple Pi processes) not a data model change.

---

# Parallel Execution Strategy

Phases define logical dependency order but don't execute serially. Freeze shared contracts early, assign one owner per shared pathway, let downstream work build against those contracts.

## Shared pathway owners (single-owner rule)

### Owner 1 — Data contract
Owns: SQLite schema (including workstreams), migrations, blackboard query helpers, transcript normalized item shape.
Freezes: DB schema, indexes, transcript preview response shape.

### Owner 2 — Control-surface API + Router
Owns: `/status`, `/message`, `/hook/:event`, `/api/sessions`, `/api/sessions/:sessionId`, `/api/sessions/:sessionId/transcript`, `/api/workstreams`, `/sessions/:sessionId/message`, `/runtime/whatsapp/start`, `/runtime/whatsapp/stop`, `/ws`, router classification contract.
Freezes: HTTP request/response payloads, WS event/message payloads, auth header/query-token contract, router input/output shape.

### Owner 3 — Claude/tmux bridge + worktrees
Owns: tmux adapter, session launch/inject/list/kill pathways, git worktree create/cleanup, v1 direct-message delivery contract (`tmux_send_keys`).

### Owner 4 — Runtime packaging
Owns: `autonoma-up`, installer/uninstaller integration, runtime file layout under `~/.autonoma/`.

---

## Recommended parallel waves

### Wave 0 — Contract freeze sprint (small, critical, fast)

The only truly serial part.

**Deliverables:** DB schema + migration plan (including workstreams), control-surface endpoint list, WS event names, router classification contract, transcript normalized item shape, tmux bridge contract, runtime file layout — all frozen.

**Exit criteria:** Downstream work can stub against these interfaces without waiting.

---

### Wave 1 — Backend spine in parallel

All start after Wave 0.

| Track | Implements | Owns |
|-------|-----------|------|
| **A — Blackboard** | Phase 1: schema, migrations, query helpers (sessions, pi-sessions, workstreams), hook writer | DB internals |
| **B — Control-surface core + router** | Phase 2: router, persisted Pi, queue, Pi state tracking, routes, `send_to_user` tool, Pi event subscriptions | HTTP server/runtime/router |
| **C — Claude/tmux bridge + worktrees** | Phase 3: tmux/session adapter, git worktree management, direct session message pathway, launch/list/inject helpers | tmux adapter + worktree internals |
| **D — Installer/runtime packaging** | Installer skeleton, runtime file deployment, `autonoma-up` wrapper | Installed file layout, startup scripts |

Safe in parallel: each track owns distinct implementation surfaces, sharing only frozen interfaces.

---

### Wave 2 — Integration surfaces in parallel

Start as soon as Wave 1 has minimal working stubs.

| Track | Implements | Depends on |
|-------|-----------|-----------|
| **E — WhatsApp runtime** | Phase 4: start/stop endpoints, inbound routing through router, bidirectional sync, WhatsApp health reporting | Control-surface runtime, runtime packaging |
| **F — Browser API + transcript** | Session list/detail routes (filterable by workstream), workstream endpoints, transcript preview, WS browser stream | Control-surface API, data contract |

Safe in parallel: each track integrates against already-owned contracts.

---

### Wave 3 — Web app + system hardening in parallel

| Track | Implements |
|-------|-----------|
| **G — Web app shell** | TanStack Start scaffold, auth token plumbing, route shell, API client, WS client |
| **H — Web app UX** | Chat view, Pi drill-down, Claude Code session drill-down, workstream status, direct session message UI, WhatsApp controls + health indicator |
| **I — Runtime hardening** | Retries, logging, PID cleanup, graceful shutdown, crash handling |

Safe in parallel: frontend builds against stable APIs while hardening improves backend behind the same contracts.

---

### Wave 4 — End-to-end closure

| Track | Implements |
|-------|-----------|
| **J — Installer finalization** | Install/uninstall lifecycle, runtime asset deployment |
| **K — End-to-end QA** | install → start → message → route → workstream creation → session launch → session complete → notify → stop → uninstall; localhost browser checks; WhatsApp manual-auth smoke; transcript paging smoke |

---

## File ownership boundaries

| Team | Primary ownership |
|------|------------------|
| Data / blackboard | `src/blackboard/**`, `src/config/load-config.ts` |
| Runtime + router | `src/server.ts`, `src/runtime.ts`, `src/pi/**`, `src/classifier/**`, `src/routes/**` |
| Claude/tmux bridge + worktrees | `src/claude-sessions/**`, `src/routes/direct-session-message.ts` |
| WhatsApp integration | `src/whatsapp/**`, `src/routes/runtime-whatsapp.ts` |
| Web app | `web/src/**` |
| Runtime packaging / installer | `scripts/**`, installer/uninstaller files |

Cross-boundary contract changes go through the owner — no ad hoc edits.

---

# Fastest Path to a Usable System

Maximum throughput is **not** fully serial phases. It is:

1. **Wave 0** — freeze shared contracts (including workstreams schema and router contract)
2. **Wave 1** — blackboard, control-surface + router, tmux bridge + worktrees, installer/runtime packaging in parallel
3. **Wave 2** — WhatsApp integration, browser API completion in parallel
4. **Wave 3** — web app and hardening in parallel
5. **Wave 4** — installer closure and end-to-end QA

**Earliest useful milestone** (end of Waves 1+2): control surface alive with router classifying messages, Pi persistent and managing workstreams, Claude sessions reachable in git worktrees, WhatsApp daemon runtime-owned with bidirectional sync, browser-facing session and workstream APIs available. The app is real; the web UI becomes a consumer, not a blocker.

---

# Remaining Risks

- **Router classification quality** — Gemini Flash Lite may misclassify messages; no correction mechanism in v1
- **WhatsApp reliability** — pairing, reconnect behavior, auth expiry edge cases
- **Git worktree management** — stale worktree cleanup, branch conflicts, base branch selection
- **Transcript normalization** — exact item/event shape, large-file chunking performance
- **Startup wrappers** — final `autonoma-up` shape, PID ownership, stale PID cleanup
- **WebSocket polish** — reconnect strategy, correlation IDs, multi-tab behavior
- **Bidirectional sync edge cases** — message ordering, deduplication between surfaces

---

# Summary

**Canonical v1 dependency order:**
1. Blackboard and runtime foundation (with workstreams)
2. Control Surface core runtime + Router
3. Claude/tmux bridge, git worktrees, and machine integrations
4. WhatsApp transport integration (with bidirectional sync)
5. Web app client (three views: chat, Pi drill-down, session drill-down)
6. Installer, startup wrappers, and hardening

**Deferred to post-v1:** Cron recovery loop, multi-Pi orchestration, Skill Recursion Engine.

**Execution model:** Short shared-contract freeze, then multiple parallel waves owned by interface boundaries.

**Core principle:** Build the app as one persistent runtime first (single Pi + router + workstreams); attach channels and UI around it. The workstream data model and router classification lay the foundation for multi-Pi evolution without requiring schema changes.
