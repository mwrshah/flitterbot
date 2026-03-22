# Spec: Router Context Migration

## Problem

The web app manages shared dependencies (API client, WebSocket client, settings) through a React Context provider (`ControlSurfaceProvider`) and a second React Context (`PiSessionContext`) for Pi-specific WS state. This duplicates what TanStack Router's context system already provides — the router context pattern is already in use for `queryClient` but not extended to the control surface clients.

Consequences:
- **Two parallel context systems** — router context for `queryClient`, React Context for everything else. Consumers must know which system holds which dependency.
- **WS connection lifecycle tied to React rendering** — `useEffect` in `ControlSurfaceProvider` connects/disconnects the WebSocket. During SSR hydration the provider hasn't mounted yet, so any component that renders before hydration completes gets no WS client.
- **Silent send failures** — `pi.route.tsx` `sendMessage` catches WS errors and falls back to HTTP, but HTTP errors are also swallowed. No error surfaces to the user.
- **PiSessionContext is a React Context wrapping router Outlet** — the accumulated WS state (streaming text, appended items, pills) is provided to child routes via React Context when it could use an external reactive store.

## Goal

Single context system: all shared dependencies flow through TanStack Router context. Eliminate `ControlSurfaceProvider` and `PiSessionContext` as React Context providers. WS connection managed outside the React render tree. Pi session WS state delivered via a module-level reactive store, not React Context.

## Functional Requirements

### FR-1: Extend Router Context with Control Surface Clients

Add `apiClient`, `wsClient`, and `settingsStore` to the router context type in `__root.tsx`.

```
createRootRouteWithContext<{
  queryClient: QueryClient
  apiClient: AutonomaApiClient
  wsClient: AutonomaWsClient
  settingsStore: SettingsStore
}>()
```

Instantiate all clients in `router.tsx` `getRouter()` alongside `queryClient`. The `wsClient` and `apiClient` are created once — they use a `() => settingsStore.get()` closure, so they don't need re-instantiation when settings change. The `settingsStore`'s `onSettingsChange` callback triggers `wsClient.reconnect()`.

### FR-2: WS Connection Lifecycle Outside React

Call `wsClient.connect()` eagerly in `getRouter()` after construction, guarded by `typeof window !== 'undefined'`. The WS client already has auto-reconnect with backoff — connecting early means it's ready before any component renders.

Disconnect via a `window.addEventListener('beforeunload', ...)` — not in a React `useEffect`.

### FR-3: Consumers Access via `routeContext` / `useRouteContext`

All current `useControlSurface()` call sites switch to accessing router context:

- **In route components** (files with a `Route` export): `Route.useRouteContext()` to destructure `apiClient`, `wsClient`, etc.
- **In non-route components** (layout, shared components): `getRouteApi('__root__').useRouteContext()` to access the root route's context.

The `useControlSurface` hook and `ControlSurfaceProvider` are deleted.

### FR-4: Settings Reactivity

Settings (base URL, token, stub fallback) are mutable — the settings drawer can change them.

Settings live in a reactive store (`lib/settings-store.ts`) — a plain object with a subscriber list, `useSyncExternalStore`-compatible. The store is created in `getRouter()`, passed into router context as `settingsStore`. The store's `set()` method persists to localStorage and triggers the `onSettingsChange` callback (which reconnects WS).

Components that display settings (e.g., `SettingsDrawer`) access the store from route context and subscribe via `useSettings(settingsStore)` — a thin wrapper around `useSyncExternalStore`. No React Context needed.

### FR-5: Pi Session WS State — Module-Level Reactive Store

The `PiSessionContext` in `pi.route.tsx` provided `{ getSessionAccum, sendMessage, connectionState }` to child routes via React Context.

Replaced with a **module-level reactive store** (`lib/pi-session-store.ts`) that `PiLayoutRoute` initializes and writes WS events into. The store holds:
- Per-session accumulated state (appended items, streaming text, status pills)
- Connection state
- A `sendMessage` function (registered by `PiLayoutRoute` on mount)

Child routes import `piSessionStore` and subscribe via `usePiSessionStore()` (a `useSyncExternalStore` wrapper). This avoids any context mechanism — just a shared module reference with reactive subscriptions.

The store is reset on each `PiLayoutRoute` mount via `resetPiSessionStore()` to ensure clean state.

### FR-6: Send Error Surfacing

The `sendMessage` callback surfaces errors instead of swallowing them:

- WS failure is logged to console and triggers HTTP fallback.
- If HTTP fallback also fails, an error pill ("Failed to send message") is added to the session's status pills and the error is logged to console.

### FR-7: Delete ControlSurfaceProvider

After migration:
- Delete `web/src/hooks/use-control-surface.tsx`
- Remove `ControlSurfaceProvider` wrapper from `__root.tsx` `RootComponent`
- Delete `PiSessionContext` and `usePiSession` from `pi.route.tsx`

## Files Changed

```
web/src/
  router.tsx                              ← create settings store + clients, connect WS, pass in router context
  lib/settings-store.ts                   ← new: reactive settings store (useSyncExternalStore-compatible)
  lib/pi-session-store.ts                 ← new: module-level reactive store for Pi WS session state
  hooks/use-control-surface.tsx           ← DELETE
  routes/__root.tsx                       ← expand context type, remove ControlSurfaceProvider wrapper
  routes/pi.route.tsx                     ← replace PiSessionContext with pi-session-store, add send error surfacing
  routes/pi.default.tsx                   ← switch from usePiSession() to usePiSessionStore()
  routes/pi.$sessionId.tsx                ← switch from usePiSession() to usePiSessionStore()
  components/layout/AppShell.tsx          ← getRouteApi('__root__').useRouteContext()
  components/layout/Sidebar.tsx           ← getRouteApi('__root__').useRouteContext()
  components/layout/SettingsDrawer.tsx    ← useSettings(settingsStore) from route context
  components/input-surface/InputSurface.tsx ← getRouteApi('__root__').useRouteContext()
  components/sessions/TranscriptViewer.tsx  ← getRouteApi('__root__').useRouteContext()
  components/sessions/SessionDetail.tsx     ← getRouteApi('__root__').useRouteContext()
  components/runtime/WhatsAppControls.tsx   ← getRouteApi('__root__').useRouteContext()
  routes/runtime.tsx                        ← Route.useRouteContext()
  routes/sessions.index.tsx                 ← Route.useRouteContext()
  routes/sessions.$sessionId.tsx            ← Route.useRouteContext()
  routes/sessions.workstream.$workstreamId.tsx ← Route.useRouteContext()
```

## Migration Order

1. **Create `settings-store.ts`** — reactive store, no React dependency.
2. **Create `pi-session-store.ts`** — module-level reactive store for Pi WS state.
3. **Extend `router.tsx`** — instantiate settings store + clients, connect WS, pass all into router context.
4. **Update `__root.tsx`** — expand context type, remove `ControlSurfaceProvider` wrapper.
5. **Migrate consumers** — switch each `useControlSurface()` call to `Route.useRouteContext()` or `getRouteApi('__root__').useRouteContext()`. Each is a self-contained change; parallelizable across files.
6. **Migrate Pi session context** — refactor `pi.route.tsx` to use `piSessionStore`, update `pi.default.tsx` and `pi.$sessionId.tsx` to use `usePiSessionStore()`.
7. **Add send error surfacing** — update `sendMessage` in `pi.route.tsx` to log and add error pills.
8. **Delete `use-control-surface.tsx`**.

Steps 5 can be parallelized across files. Steps 1-4 must be sequential. Steps 6-8 depend on 5 completing for the Pi routes.

## Risks

1. **SSR hydration mismatch** — `wsClient` is a browser-only object (uses `WebSocket` API). On server, the client must exist but be inert — `connect()` is guarded by `typeof window !== 'undefined'`, and the `AutonomaWsClient` constructor handles missing `WebSocket` via try/catch.
2. **Settings drawer needs write access** — `settingsStore` is in router context. Its `set()` method closes over the mutable state, so the store reference is stable even though values change.
3. **Pi session store lifecycle** — the module-level singleton is reset on each `PiLayoutRoute` mount. If the Pi route is unmounted and remounted, accumulated state resets. This matches the previous React Context behavior (state was local to the provider component).
4. **Memory: store subscriber cleanup** — `useSyncExternalStore` handles cleanup automatically. No leak risk.
