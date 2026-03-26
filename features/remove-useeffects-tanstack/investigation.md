# useEffect Investigation Report

## Summary Stats

| Metric | Count |
|--------|-------|
| **Total useEffect calls** | 21 |
| **Files with useEffect** | 9 |
| DATA_FETCH | 0 |
| SYNC_STATE | 3 |
| SIDE_EFFECT | 17 |
| NAV_REDIRECT | 0 |

TanStack Query already handles all data fetching — no useEffect-based fetches remain. The remaining useEffects are WebSocket subscriptions, DOM imperative operations, and state syncing.

---

## TanStack Router & Query Status

| Package | Version | Status |
|---------|---------|--------|
| @tanstack/react-router | ^1.166.2 | Installed, active |
| @tanstack/react-query | ^5.90.0 | Installed, active |
| @tanstack/react-router-ssr-query | ^1.166.2 | SSR integration configured |
| @tanstack/react-start | ^1.166.2 | Meta-framework in use |

**Router loaders already used in 5 routes:**
- `__root.tsx` — ensures status query data
- `index.tsx` — fetches PI input history
- `pi.$sessionId.tsx` — loads chat history (with 404 redirect)
- `pi.default.tsx` — loads default PI history
- `pi.route.tsx` — ensures status query data

**beforeLoad used in 1 route:**
- `pi.index.tsx` — redirect from `/pi/` to `/pi/default`

**Query hooks used across codebase:** `useQuery`, `useMutation`, `useQueryClient` in 9 files. Query options defined in `lib/queries.ts` (statusQueryOptions, piHistoryQueryOptions).

---

## Every useEffect — Categorized

### `routes/__root.tsx`

| # | Line | Category | Description | Migration |
|---|------|----------|-------------|-----------|
| 1 | 94 | SIDE_EFFECT | Subscribes to WS messages to invalidate status/workstreams queries | Keep — legitimate subscription with cleanup. Could extract to a shared WS-query-sync utility outside React. |
| 2 | 103 | SIDE_EFFECT | Re-invalidates all queries and route loaders on WS reconnect | Keep — legitimate subscription with cleanup. Same extraction opportunity as #1. |

### `routes/pi.default.tsx`

| # | Line | Category | Description | Migration |
|---|------|----------|-------------|-----------|
| 3 | 61 | SYNC_STATE | Clears previous session's accumulator when defaultSessionId changes | Replace with cleanup logic in piSessionStore or a ref-based pattern outside useEffect. |

### `hooks/use-pi-ws-handler.ts`

| # | Line | Category | Description | Migration |
|---|------|----------|-------------|-----------|
| 4 | 26 | SIDE_EFFECT | Resets piSessionStore on mount | Move to store initialization — no need for an effect. |
| 5 | 31 | SIDE_EFFECT | Subscribes to wildcard WS session events | Keep — subscription with cleanup. Could move to store/service layer. |
| 6 | 39 | SIDE_EFFECT | Main WS event handler routing all events to piSessionStore (~190 lines) | Keep — core subscription. Extract handler logic to a pure function; keep only subscribe/unsubscribe in effect. |
| 7 | 231 | SYNC_STATE | Sets initial connection state from wsClient | Move to store initialization — derive from wsClient directly. |
| 8 | 236 | SIDE_EFFECT | Registers sendMessage function on the store for WS+HTTP fallback | Move to store initialization — register once when store/wsClient are created. |

### `hooks/use-stick-to-bottom.ts`

| # | Line | Category | Description | Migration |
|---|------|----------|-------------|-----------|
| 9 | 31 | SIDE_EFFECT | Scroll listener + ResizeObserver + MutationObserver for auto-scroll-to-bottom | Keep — imperative DOM behavior. This is a valid use of useEffect. |

### `hooks/use-theme.ts`

| # | Line | Category | Description | Migration |
|---|------|----------|-------------|-----------|
| 10 | 40 | SIDE_EFFECT | Applies theme class to document when theme changes | Keep — DOM side effect. Could move to store subscribe callback. |
| 11 | 45 | SIDE_EFFECT | Listens to `prefers-color-scheme` media query changes | Keep — event listener with cleanup. |

### `components/input-surface.tsx`

| # | Line | Category | Description | Migration |
|---|------|----------|-------------|-----------|
| 12 | 153 | SYNC_STATE | Detects if content overflows max-height (no deps — runs every render) | Replace with ResizeObserver or measure in a callback ref. Running every render is wasteful. |
| 13 | 248 | SIDE_EFFECT | Initializes pi-web-ui library (LitMarkdownBlock) | Deduplicate — extract shared `usePiWebUiReady()` hook. |
| 14 | 260 | SIDE_EFFECT | Sets markdown-block content property imperatively | Keep — imperative web component update. |

### `components/pi-message-list.tsx`

| # | Line | Category | Description | Migration |
|---|------|----------|-------------|-----------|
| 15 | 26 | SIDE_EFFECT | Initializes pi-web-ui library (duplicate of #13) | Deduplicate — use shared `usePiWebUiReady()` hook. |
| 16 | 46 | SIDE_EFFECT | Creates message-list web component and updates properties | Keep — imperative web component management. |
| 17 | 66 | SIDE_EFFECT | Nullifies element ref on unmount | Merge into #16's cleanup function. |

### `components/pi-streaming-message.tsx`

| # | Line | Category | Description | Migration |
|---|------|----------|-------------|-----------|
| 18 | 22 | SIDE_EFFECT | Initializes pi-web-ui library (duplicate of #13) | Deduplicate — use shared `usePiWebUiReady()` hook. |
| 19 | 42 | SIDE_EFFECT | Creates assistant-message web component and updates properties | Keep — imperative web component management. |

### `components/transcript-viewer.tsx`

| # | Line | Category | Description | Migration |
|---|------|----------|-------------|-----------|
| 20 | 16 | SIDE_EFFECT | Initializes pi-web-ui library (duplicate of #13) | Deduplicate — use shared `usePiWebUiReady()` hook. |
| 21 | 28 | SIDE_EFFECT | Sets markdown-block content property imperatively | Keep — imperative web component update. |

---

## Patterns Found

### 1. Duplicated pi-web-ui initialization (4 copies)
Files: `input-surface.tsx`, `pi-message-list.tsx`, `pi-streaming-message.tsx`, `transcript-viewer.tsx`

All four have identical `ensurePiWebUiReady()` effects with cancellation. Extract into a shared `usePiWebUiReady()` hook that returns `{ ready, error }`.

### 2. WebSocket subscription effects (5 in use-pi-ws-handler.ts, 2 in __root.tsx)
Seven effects managing WS subscriptions. Three of them (#4, #7, #8) are initialization disguised as effects — they can be moved to store construction. The remaining four are legitimate subscribe/unsubscribe patterns.

### 3. Imperative web component management (5 effects)
Effects that create and update Lit-based web components (`message-list`, `assistant-message`, `markdown-block`). These are inherently imperative and are valid useEffect usage — React has no declarative way to manage web component properties.

### 4. No-dependency effect running every render (#12)
`input-surface.tsx:153` has no dependency array — it runs on every render to check overflow. Should use a ResizeObserver instead.

---

## Recommended Migration Approach

### Phase 1: Quick Wins (deduplication + initialization cleanup)
1. **Extract `usePiWebUiReady()` hook** — consolidate 4 identical initialization effects into one shared hook
2. **Move store initialization out of effects** — `resetPiSessionStore()`, `setConnectionState()`, and `sendMessage` registration (#4, #7, #8) should happen at store/service creation time, not in useEffect
3. **Fix the no-deps effect** (#12) — replace with ResizeObserver in a callback ref
4. **Merge cleanup effect** (#17) into parent effect (#16)

### Phase 2: Evaluate WebSocket subscription extraction
The WS subscription effects in `__root.tsx` and `use-pi-ws-handler.ts` are legitimate side effects with proper cleanup. Options:
- **Keep as useEffect** — they follow the correct pattern (subscribe on mount, unsubscribe on cleanup)
- **Extract to service layer** — move WS→Query invalidation logic into `wsClient` itself, removing the need for React effects entirely
- **Use TanStack Query's `onlineManager`** — for the reconnection logic specifically

### Phase 3: Keep as-is (legitimate useEffect)
- `use-stick-to-bottom.ts` — imperative scroll/resize/mutation observers
- `use-theme.ts` — DOM class manipulation and media query listener
- Web component property updates — inherently imperative

### What NOT to migrate
- No useEffects are doing data fetching (TanStack Query already handles this)
- No useEffects are doing navigation/redirects (beforeLoad already handles the one redirect)
- The imperative web component effects cannot be replaced by loaders or queries — they manage DOM elements that React doesn't own
