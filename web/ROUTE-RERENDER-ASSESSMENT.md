# Route & Layout Re-render Assessment

Investigation of excessive re-renders in route components and layout, traced from WDYR logs.

---

## Priority Ranking (worst offenders first)

| # | Component | Severity | Root Cause |
|---|-----------|----------|------------|
| 1 | **PiSessionRoute** | HIGH | `usePiSessionStore()` returns full snapshot — ANY session update rerenders ALL session routes; `useLoaderData()` returns new object ref on every render cycle |
| 2 | **PiDefaultRoute** | HIGH | Same `usePiSessionStore()` problem; `history Array(0)->Array(0)` from `historyQuery.data ?? []` creating new empty array; `loaderData` object recreated |
| 3 | **TabLink** | MEDIUM | Inline JSX children (`children changed Array(2)->Array(2)`) — parent creates new child arrays every render |
| 4 | **PiLayoutRoute** | LOW-MED | `pathname` selector causes expected rerenders on navigation, but cascades into all TabLinks unnecessarily |
| 5 | **RootDocument** | LOW | `children` prop always new ref because parent (`RootComponent`) rerenders — mostly passthrough noise |

---

## Per-Component Analysis

### 1. PiSessionRoute (`pi.$sessionId.tsx`)

**What triggers it:**
- `usePiSessionStore()` (line 33) — subscribes to the **entire** `PiSessionSnapshot` via `useSyncExternalStore`. Every `notify()` call (any session update, connection state change, pill add/remove) creates a new snapshot object (`{ sessions: new Map(sessions), connectionState }` — see `pi-session-store.ts:88`), causing ALL consumers to rerender.
- `Route.useLoaderData()` (line 32) — TanStack Router's `useLoaderData()` returns a new object reference on each render cycle. The `?.history ?? []` fallback compounds this: when `history` is undefined, a new empty array is created each time.
- `piSessionStore.getSessionAccum(sessionId)` (line 34) — called during render (not memoized). Returns `EMPTY_ACCUM` (frozen sentinel) for missing sessions which IS stable, but for active sessions returns the Map-stored reference which changes on every `updateSession` call.
- `piSessionStore.getSendMessage()` (line 35) — called during render. Returns a cached function, but the cache is invalidated on every `setSendMessage` call (triggered by `usePiWsHandler` on `[wsClient, apiClient]` change).
- Inline `onSendMessage` callback (line 50-52) — new arrow function every render, passed to `ChatPanel`.

**Is it necessary?**
Mostly NO. The component only cares about its OWN session's accum, yet `usePiSessionStore()` fires on ANY session's update. The `history` array from loader data hasn't changed content — just reference. The `sendMessage` reference is stable in practice but the architecture doesn't guarantee it.

**Fix approach:**
- Replace `usePiSessionStore()` with a session-scoped selector: `usePiSessionAccum(sessionId)` that only returns the relevant `SessionAccum` and uses `Object.is` equality to skip rerenders when the accum hasn't changed.
- Extract `connectionState` subscription separately: `usePiConnectionState()`.
- Memoize `history` from loader data with `useMemo` + length/content check, or use TanStack Router's `structuralSharing` option on the route.
- Wrap `onSendMessage` in `useCallback`.

---

### 2. PiDefaultRoute (`pi.default.tsx`)

**What triggers it:**
- `usePiSessionStore()` (line 44) — same global snapshot problem as PiSessionRoute.
- `Route.useLoaderData()` (line 42) — returns new object ref each render. The `loaderData` object itself is a WDYR trigger.
- `historyQuery.data ?? []` (line 58) — when `historyQuery.data` is undefined (loading state), `?? []` creates a new empty array on every render. Even when data exists, React Query may return a new reference after refetch if `structuralSharing` is not configured (it's not — checked, no `structuralSharing` in query options).
- `piSessionStore.getSessionAccum("")` (line 59) — when `defaultSessionId` is undefined, this calls `getSessionAccum("")` which returns `EMPTY_ACCUM` (stable). But once a session exists, the accum reference changes on every store update.
- `piSessionStore.getSendMessage()` (line 45) — same cache invalidation concern.
- Inline `onSendMessage` (line 89-91) — new arrow function every render.

**Is it necessary?**
Mostly NO. Same over-subscription pattern. The `history Array(0)->Array(0)` symptom is a textbook unstable empty array fallback.

**Fix approach:**
- Same session-scoped selector as PiSessionRoute.
- Stabilize empty array: `const EMPTY_HISTORY: ChatTimelineItem[] = []` at module level, use as fallback.
- Enable `structuralSharing: true` on `piHistoryQueryOptions` (React Query supports this by default but it may be getting bypassed).
- Wrap `onSendMessage` in `useCallback`.

---

### 3. TabLink (`pi.route.tsx:92-115`)

**What triggers it:**
- `children changed Array(2)->Array(2)` — the parent (`PiLayoutRoute`) passes inline JSX children:
  ```tsx
  <TabLink to="/pi/default" active={...}>
    Default
    {defaultPi?.busy && <Badge variant="success">active</Badge>}
  </TabLink>
  ```
  React compiles this to `[string, ReactElement | false]`. On every parent render, a **new array** is created even though the content is identical. Same pattern for the mapped orchestrator tabs (lines 71-79).
- `active` prop changes (expected on navigation).
- Parent rerenders from `pathname` change (expected) or `statusQuery` data change (may be unnecessary if orchestrator list hasn't changed).

**Is it necessary?**
The `active` prop change on navigation is expected. The `children` array recreation is NOT necessary — it's the classic inline-children anti-pattern. Every `PiLayoutRoute` rerender forces ALL TabLinks to rerender even if only `active` changed on one tab.

**Fix approach:**
- Wrap `TabLink` in `React.memo()`. This alone won't help with `children` since the array ref always changes.
- Extract tab data into a stable array of `{ to, label, busy }` objects (memoized), then render children inside `TabLink` from props rather than passing JSX children. This avoids the inline children problem entirely.
- Alternatively, split into `<TabLink to={...} active={...} label="Default" busy={defaultPi?.busy} />` — flat primitive props that `React.memo` can shallow-compare.

---

### 4. PiLayoutRoute (`pi.route.tsx:25-88`)

**What triggers it:**
- `useRouterState({ select: (s) => s.location.pathname })` (line 29) — fires on every navigation. The `select` function is recreated each render (inline arrow), but TanStack Router compares the selected value, so this only triggers when pathname actually changes. This is **expected** behavior on navigation.
- `useQuery(statusQueryOptions(...))` (line 32-35) — fires when status query is invalidated (WS reconnect, `workstreams_changed`, `status_changed`). Returns new data reference even if content is unchanged (no structural sharing configured).
- Derived state computed every render: `allOrchestrators`, `openWsIds`, `openOrchestrators`, `ephemeralOrchestrator`, `orchestrators` (lines 37-60) — all create new arrays/sets/objects. Not memoized.

**Is it necessary?**
Pathname-triggered rerenders are expected on navigation. But the cascade is problematic:
1. Pathname changes → PiLayoutRoute rerenders → ALL TabLinks rerender (children change)
2. Status query refetch → new orchestrator arrays → ALL TabLinks rerender

The derived state computation (filtering orchestrators, building tab list) runs on every render without memoization.

**Fix approach:**
- Memoize `orchestrators` array with `useMemo` keyed on `allOrchestrators`, `workstreams`, `currentSessionId`.
- Use `select` option on the `useQuery` call to extract only the fields needed (orchestrators + defaultPi), with structural comparison.
- Combined with `React.memo` on TabLink, this would prevent most cascade rerenders.

---

### 5. RootDocument (`__root.tsx:124-143`)

**What triggers it:**
- `children` prop changes on every `RootComponent` rerender. `RootComponent` rerenders when:
  - `statusQuery` updates (status polling/invalidation)
  - `useRouter()` returns new router ref (shouldn't happen often)
  - `useQueryClient()` returns new client ref (shouldn't happen often)
  - WS connection state changes (via `usePiWsHandler` triggering store updates)

**Is it necessary?**
Mostly NO. `RootDocument` is a pure wrapper (`<html><head><body>{children}</body></html>`). It should almost never need to rerender. The children are `<AppShell />` which is a stable JSX element — but since `RootComponent` recreates the JSX tree on each render, the children ref changes.

**Fix approach:**
- Wrap `RootDocument` in `React.memo()`. Since `children` is always a new ref, this alone won't help.
- Better: move `RootDocument` to be the static outer shell and have `RootComponent` logic inside it, or use the `component` composition differently so `RootDocument` doesn't receive children as a prop.
- Practically lowest priority since `RootDocument` is cheap to render (just HTML wrapper elements).

---

## Root Causes Summary

### 1. Global store subscription (`usePiSessionStore`) — HIGH IMPACT
The `useSyncExternalStore` hook subscribes to the entire `PiSessionSnapshot`. The `notify()` function in `pi-session-store.ts:87-89` creates `new Map(sessions)` on every update, guaranteeing a new snapshot reference. Every component using `usePiSessionStore()` rerenders on ANY session's update, even if its own session data is unchanged.

**Pattern:** Global store → O(n) rerenders for n consumers on every single event.

### 2. Inline JSX children creating unstable refs — MEDIUM IMPACT
TabLink receives `children` as inline JSX arrays. React always creates new element/array references for inline children, defeating any potential `React.memo` optimization.

### 3. Unstable empty array/object fallbacks — MEDIUM IMPACT
Multiple instances of `?? []` creating new empty arrays on every render:
- `pi.$sessionId.tsx:32`: `useLoaderData()?.history ?? []`
- `pi.default.tsx:58`: `historyQuery.data ?? []`
- `pi.route.tsx:37-39`: `statusQuery.data?.pi?.orchestrators ?? []`, `statusQuery.data?.workstreams ?? []`

### 4. Missing memoization on derived state — LOW-MEDIUM IMPACT
`PiLayoutRoute` computes filtered orchestrator arrays on every render without `useMemo`. Combined with the children instability, this means every navigation recomputes tabs AND forces all TabLinks to rerender.

### 5. Inline callback props — LOW IMPACT
`onSendMessage` in both PiSessionRoute and PiDefaultRoute creates new arrow functions each render. Not a direct rerender cause (the components already rerender for other reasons), but prevents `React.memo` on `ChatPanel` from working.

### 6. No `structuralSharing` on TanStack Router loaderData — LOW IMPACT
TanStack Router supports `structuralSharing` on route definitions to preserve referential equality when loader data is deeply equal. Not configured on any route, so `useLoaderData()` returns new refs after every loader run.
