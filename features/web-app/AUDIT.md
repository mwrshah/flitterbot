# Web App Feature Audit

Audited 2026-03-24 against `web/src/`.

## Matches

- **Architecture**: Thin client, no hosted Pi, no orchestration logic. Browser renders; control surface owns all backend concerns. Confirmed.
- **Stack**: TanStack Start (SSR + file-based routing), Tailwind CSS v4 (oklch color system), Lit web components for chat, `marked` + `highlight.js` in chat, `cmdk` for skill picker. All confirmed via `package.json` and source.
- **Router & context injection**: `router.tsx` injects `QueryClient`, `AutonomaApiClient`, `AutonomaWsClient`, `SettingsStore` via router context (not React Context). SSR data loading via `createServerFn` in `server/pi.ts`. Client-side polling via TanStack Query. Confirmed.
- **Route structure**: All routes exist as documented — `/` (Input Surface), `/pi` (layout), `/pi/default`, `/pi/$sessionId`, `/sessions` (layout + index), `/sessions/$sessionId`, `/runtime`. Polling intervals match (10s sessions, 5s runtime). Confirmed.
- **Root layout**: `__root.tsx` subscribes to WS `workstreams_changed` and `status_changed`, invalidates query caches, re-invalidates on WS reconnect. Confirmed.
- **Three stores with `useSyncExternalStore`**: No Zustand, no React Context providers. Confirmed.
  - **PiSessionStore**: Module-level singleton, per-session `appendedItems`/`streamingText`/`statusPills` (max 6), reset on Pi layout mount. Confirmed.
  - **SettingsStore**: localStorage-backed, `set()` persists and triggers WS reconnect. Confirmed.
  - **WebSocket client**: Auto-reconnect with exponential backoff (3s -> 30s), per-session subscriptions, re-subscribes on reconnect. Confirmed.
- **Pi-Web-UI bridge**: `timelineToAgentMessages()` converts `ChatTimelineItem[]` -> `AgentMessage[]` with look-ahead for inline tool calls. Lazy-loaded via `ensurePiWebUiReady()`. Confirmed.
- **Timeline merging**: `mergeTimelines` in `lib/utils.ts` deduplicates appended items against loader history by ID. Confirmed.
- **WS message types**: `text_delta`, `message_end`, `tool_execution_start/end`, `queue_item_start/end`, `turn_end`, `error`, `connected`. All present in types.ts. Confirmed.
- **Components directory structure**: `layout/`, `chat/`, `input-surface/`, `sessions/`, `runtime/`, `ui/` — all present as documented.
- **Skill picker**: Slash-command dropdown with `cmdk`, fetches from `GET /api/skills`. Confirmed.
- **Image attachments**: Clipboard paste, drag-drop, file picker, base64-encoded. Confirmed in `MessageInput.tsx`.
- **Delivery modes**: `followUp` (queue) vs `steer` (interrupt) toggle. Confirmed.
- **Origin badges**: web, whatsapp, hook, cron, init — with per-source colors. Confirmed.
- **Theme**: light/dark/system, localStorage-persisted, flash-prevented via inline script. Confirmed.
- **Runtime controls**: WhatsApp start/stop via `POST /runtime/whatsapp/{start,stop}`. Confirmed.
- **Constraints**: Localhost only, bearer token auth, paginated transcripts, browser is client only. Confirmed.
- **Dependencies**: `@mariozechner/pi-agent-core` for Lit components and Pi SDK types. Confirmed.
- **Observations**: Both observations in the doc (mergeTimelines location, pi-web-ui error handling) confirmed.

## Divergences

1. **Markdown rendering stack**: Doc says "`react-markdown` + `remark-gfm` in transcripts." Neither `react-markdown` nor `remark-gfm` is in `package.json`. Transcript rendering uses Lit `<markdown-block>` components powered by `marked` + `highlight.js` — the same stack as chat, not a separate React-based one.
2. **Pi-Web-UI lazy loading**: Doc says lazy-loaded via `ensurePiWebUiReady()` in `lib/pi-web-ui-bridge.ts`. The function actually lives in a separate file: `lib/pi-web-ui-init.ts`. The bridge file handles data conversion only.
3. **Additional WS message types**: Doc lists 8 WS types. Implementation also has `pi_surfaced`, `workstreams_changed`, and `status_changed` — the latter two are mentioned in the root layout section but not in the WS message types list.

## Missing from Doc

1. **`pi.index.tsx` route**: A redirect route at `/pi/` that redirects to `/pi/default`. Not listed in the route structure.
2. **WS -> HTTP fallback**: `pi.route.tsx` tries WS for `sendMessage()` first, then falls back to HTTP `POST /message` on failure. Not documented.
3. **Input Surface filtering**: Only renders user + pi-response messages (no tool calls). Filters intermediate assistant messages, only shows final `pi_surfaced`. Parses workstream prefixes via regex. Not documented.
4. **Status pills lifecycle**: Max 6 pills (`.slice(-6)`), source-specific styling, auto-removal on `queue_item_end`. The max-6 detail is documented but the lifecycle is not.
5. **Transcript pagination details**: Uses `useInfiniteQuery` with cursor-based pagination, 25 items/page, "Load more" button. Not documented beyond "paginated rendering."
6. **SettingsStore env var fallback**: Falls back to `VITE_AUTONOMA_BASE_URL` and `VITE_AUTONOMA_TOKEN` env vars, then to `http://127.0.0.1:18820`. Doc says "stub fallback" but doesn't detail the env var chain.
7. **API client methods**: Full set of HTTP endpoints (`getStatus`, `listSessions`, `getSessionDetail`, `getTranscript`, `sendMessage`, `sendDirectSessionMessage`, `getPiHistory`, `startWhatsApp`, `stopWhatsApp`, `listSkills`) not enumerated.
8. **Skill fetching details**: Both InputSurface and ChatPanel fetch skills independently with 5-minute staleTime, no refetch on focus.
9. **`pi_surfaced` WS event**: Used by Input Surface to show final Pi responses. Key to how the Input Surface works but not mentioned.
10. **Connection state type**: WS client tracks `"connected" | "connecting" | "reconnecting" | "stub" | "disconnected"` — not documented.
11. **PiSessionStore `sendMessage` callback**: Deferred callback registration pattern for message sending — not documented.

## Missing from Implementation

Nothing identified — all features described in the doc are implemented. The doc is a subset of the actual implementation.
