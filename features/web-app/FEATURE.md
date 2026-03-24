# Feature: Web App

Thin browser client for Autonoma — chat with Pi, browse sessions, inspect transcripts, direct-message sessions, monitor runtime.

## Problem

Terminal limits you to one tmux session; transcripts are raw JSONL; no overview exists. The web app is the single pane of glass.

## Architecture

**Thin client** — no hosted Pi, no `createAgentSession()`, no orchestration logic. Browser renders; control surface owns all Pi sessions, WebSocket streaming, APIs, blackboard access.

```
Browser (React) ──renders──▸ Pi-Web-UI (Lit components) ──renders──▸ chat messages
Browser (React) ──HTTP/WS──▸ Control Surface ──▸ Pi, Blackboard, tmux, WhatsApp
```

**Stack:** TanStack Start (SSR + file-based routing), Tailwind CSS v4 (`oklch` color system), Lit web components for chat, `marked` + `highlight.js` in chat, `react-markdown` + `remark-gfm` in transcripts.

### Router & Data Flow

TanStack Router with dependency-injected context — `QueryClient`, `AutonomaApiClient`, `AutonomaWsClient`, `SettingsStore` — instantiated in `router.tsx`, passed via router context (not React Context). SSR data loading via `createServerFn`; client-side polling via TanStack Query (5–30s).

**Route structure:**
- `/` — Input Surface: alternative message surface for Pi input sessions
- `/pi` — Pi Agent layout: tab bar, WS event routing, session accumulation
  - `/pi/default` — default Pi session
  - `/pi/$sessionId` — orchestrator workstream session
- `/sessions` — Claude Code session list (10s polling)
  - `/sessions/$sessionId` — session detail + paginated transcript
- `/runtime` — system status dashboard (5s polling)

Root layout (`__root.tsx`) subscribes to WS `workstreams_changed` and `status_changed` events, invalidating React Query caches on change and on WS reconnect.

### State Management

Three stores, all using `useSyncExternalStore` — no Zustand, no React Context providers:

1. **PiSessionStore** (`lib/pi-session-store.ts`) — module-level singleton. Per-session accumulators: `appendedItems` (timeline items since loader), `streamingText` (partial deltas), `statusPills` (transient feedback, max 6). Reset on Pi layout mount. Initialized by `pi.route.tsx`, consumed by child routes.

2. **SettingsStore** (`lib/settings-store.ts`) — localStorage-backed. Controls base URL, bearer token, stub fallback. `set()` persists and triggers WS reconnect.

3. **WebSocket client** (`lib/ws.ts`) — auto-reconnect with exponential backoff (3s → 30s). Per-session subscriptions; re-subscribes on reconnect. Pub/sub for message and connection state. Primary transport; HTTP is fallback.

### Pi-Web-UI Bridge

Lit web components from `@mariozechner/pi-agent-core` render chat. Bridge (`lib/pi-web-ui-bridge.ts`) converts `ChatTimelineItem[]` → `AgentMessage[]` with look-ahead for inline tool calls. Lazy-loaded via `ensurePiWebUiReady()`, mounted through React refs in `PiMessageList`. `PiStreamingMessage` handles partial deltas.

### Timeline Merging

Each Pi session merges loader history with live appended items (`displayed = loaderHistory ++ appendedItems`), deduplicated by ID. WS events flow through `pi.route.tsx` → `piSessionStore` by session ID; child routes subscribe and re-render.

WS message types: `text_delta`, `message_end`, `tool_execution_start/end`, `queue_item_start/end` (status pills), `turn_end` (divider), `error`, `connected`.

## Key Files

```
web/src/
├── router.tsx                    # router factory, context injection
├── routeTree.gen.ts              # auto-generated route tree
├── routes/
│   ├── __root.tsx                # root layout, WS ↔ query invalidation
│   ├── index.tsx                 # Input Surface
│   ├── pi.route.tsx              # Pi layout: tabs, WS routing, accumulation
│   ├── pi.default.tsx            # default session view
│   ├── pi.$sessionId.tsx         # orchestrator session view
│   ├── sessions.route.tsx        # sessions layout
│   ├── sessions.index.tsx        # session list
│   ├── sessions.$sessionId.tsx   # session detail + transcript
│   └── runtime.tsx               # runtime dashboard
├── components/
│   ├── layout/                   # AppShell, Sidebar, SettingsDrawer
│   ├── chat/                     # ChatPanel, PiMessageList, PiStreamingMessage
│   ├── input-surface/            # InputSurface, SkillPicker
│   ├── sessions/                 # SessionList, SessionDetail, TranscriptViewer
│   ├── runtime/                  # WhatsAppControls
│   └── ui/                       # MessageInput, Badge, Button, Card, etc.
├── hooks/                        # use-stick-to-bottom, use-theme
├── lib/
│   ├── api.ts                    # HTTP client factory
│   ├── ws.ts                     # WebSocket client with reconnect
│   ├── pi-session-store.ts       # per-session reactive store
│   ├── settings-store.ts         # localStorage-backed settings
│   ├── pi-web-ui-bridge.ts       # ChatTimelineItem → AgentMessage conversion
│   ├── types.ts                  # all shared types
│   ├── queries.ts                # TanStack Query options
│   └── utils.ts                  # helpers
├── server/pi.ts                  # createServerFn wrappers for Pi APIs
├── pi-web-ui/                    # Lit component definitions (~10k lines)
├── styles.css                    # base + markdown-body styles
└── pi-web-ui.css                 # pre-compiled Lit component styles
```

## Capabilities

- **Pi chat:** two surfaces — Input Surface (`/`) for input sessions, Pi Agent (`/pi`) for default + orchestrator sessions
- **Session dashboard:** status, task, worktree, last activity per Claude Code session
- **Transcript viewer:** paginated rendering of JSONL transcripts as conversation
- **Direct messaging:** send messages to specific sessions via control surface
- **Skill picker:** slash-command dropdown (`/` trigger) with `cmdk`, fetches available skills from `GET /api/skills`
- **Image attachments:** clipboard paste, drag-drop, file picker (base64-encoded)
- **Delivery modes:** followUp (queue) vs steer (interrupt)
- **Origin badges:** web, whatsapp, hook, cron
- **Theme:** light/dark/system, localStorage-persisted, flash-prevented via inline script
- **Runtime controls:** WhatsApp daemon start/stop, orchestrator status

## Constraints

- Localhost only (v1) — bearer token auth, no network auth
- Large transcripts (100MB+) paginated, never loaded fully
- Browser is client only — no orchestration, no hosted Pi
- No prebuilt agent UI framework — hand-rolled components + Lit chat rendering

## Dependencies

- Control Surface (Pi host, REST API, WebSocket)
- Blackboard (session state, transcript paths)
- `@mariozechner/pi-agent-core` (Lit web components, Pi SDK types)

## Observations

- **attention!** Dead code: `fetchPiStatus` in `server/pi.ts` is exported but never imported — all status fetching goes through `statusQueryOptions` in `lib/queries.ts` via the API client. Remove it.
- **attention!** Duplicate `mergeTimelines`: identical function defined in `routes/pi.route.tsx` (exported, used by child routes) and `components/input-surface/InputSurface.tsx` (local copy). Violates single-source-of-truth — extract to shared utility.
- **TBD!** Empty `.catch(() => {})` blocks swallow pi-web-ui initialization errors in `InputSurface.tsx:234` and `TranscriptViewer.tsx:22`. Failure is tracked via state flag, but the catch discards the error object — at minimum log it.
