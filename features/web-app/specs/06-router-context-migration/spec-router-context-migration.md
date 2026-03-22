# Spec: Router Context Migration

## Problem

The web app manages shared dependencies (API client, WebSocket client, settings) through a React Context provider (`ControlSurfaceProvider`) and a second React Context (`PiSessionContext`) for Pi-specific WS state. This duplicates what TanStack Router's context system already provides — the router context pattern is already in use for `queryClient` but not extended to the control surface clients.

Consequences:
- **Two parallel context systems** — router context for `queryClient`, React Context for everything else. Consumers must know which system holds which dependency.
- **WS connection lifecycle tied to React rendering** — `useEffect` in `ControlSurfaceProvider` connects/disconnects the WebSocket. During SSR hydration the provider hasn't mounted yet, so any component that renders before hydration completes gets no WS client.
- **Silent send failures** — `pi.route.tsx` `sendMessage` catches WS errors and falls back to HTTP, but HTTP errors are also swallowed. No error surfaces to the user.
- **PiSessionContext is a React Context wrapping router Outlet** — the accumulated WS state (streaming text, appended items, pills) is provided to child routes via React Context when it could use TanStack Router's own context inheritance.

## Goal

Single context system: all shared dependencies flow through TanStack Router context. Eliminate `ControlSurfaceProvider` and `PiSessionContext` as React Context providers. WS connection managed outside the React render tree.

## Functional Requirements

### FR-1: Extend Router Context with Control Surface Clients

Add `apiClient`, `wsClient`, and `settings` (plus an `updateSettings` callback) to the router context type in `__root.tsx`.

```
createRootRouteWithContext<{
  queryClient: QueryClient
  apiClient: AutonomaApiClient
  wsClient: AutonomaWsClient
  settings: ControlSurfaceSettings
  updateSettings: (next: Partial<ControlSurfaceSettings>) => void
}>()
```

Instantiate all clients in `router.tsx` `getRouter()` alongside `queryClient`. The `wsClient` and `apiClient` are created once — they already use a `getSettings` closure, so they don't need re-instantiation when settings change.

### FR-2: WS Connection Lifecycle Outside React

Move `wsClient.connect()` out of a `useEffect`. Two options:

**Option A (preferred):** Call `wsClient.connect()` eagerly in `getRouter()` after construction. The WS client already has auto-reconnect with backoff — connecting early means it's ready before any component renders.

**Option B:** Connect in the root route's `beforeLoad`. This runs once on initial navigation before any component renders, giving the same early-connect benefit with a router lifecycle hook.

Either way, disconnect in a window `beforeunload` listener or `router.subscribe('onResolved', ...)` cleanup — not in a React `useEffect`.

### FR-3: Consumers Access via `routeContext` / `useRouteContext`

All current `useControlSurface()` call sites switch to accessing router context:

- **In loaders/beforeLoad:** `context.apiClient`, `context.wsClient` from the loader's `context` parameter.
- **In components:** `Route.useRouteContext()` or the `getRouteApi` pattern. Since the root route provides these, every route inherits them.

The `useControlSurface` hook and `ControlSurfaceProvider` are deleted.

### FR-4: Settings Reactivity

Settings (base URL, token, stub fallback) are mutable — the settings drawer can change them. Current approach: React state in the provider, `useEffect` to persist to localStorage and reconnect WS.

New approach: Settings live in a lightweight reactive store (a plain object with a subscriber list — same pattern `AutonomaWsClient` already uses for connection state). The store is created in `getRouter()`, passed into router context, and the `updateSettings` callback triggers WS reconnect + localStorage persist directly — no React re-render needed for the plumbing, only for UI that displays settings values.

Components that display settings (e.g., `SettingsDrawer`) subscribe to the store via a `useSyncExternalStore` hook — React's built-in mechanism for external stores, no Context needed.

### FR-5: Pi Session WS State — Route-Scoped, No React Context

The `PiSessionContext` in `pi.route.tsx` currently provides `{ getSessionAccum, sendMessage, connectionState }` to child routes via React Context.

Replace with a **reactive store per Pi layout mount**, created in `pi.route.tsx`'s component and passed to children via TanStack Router's component-level context or — simpler — via props through `Outlet`'s `context` prop (TanStack Router supports `<Outlet context={...} />`). This is not a new React Context provider; it's the router's own mechanism for parent-to-child data flow.

The accumulated WS state (session map, streaming text, pills) remains reactive component state in `PiLayoutRoute` — it must trigger re-renders. The difference is delivery mechanism: `Outlet` context instead of `createContext`/`useContext`.

Child routes access via `Route.useRouteContext()` or the outlet context hook.

### FR-6: Send Error Surfacing

The `sendMessage` callback must surface errors instead of swallowing them:

- If WS send fails and HTTP fallback also fails, add an error pill to the session's status pills.
- Log to console in all failure cases.

This is the proximate cause of the "send does nothing" bug — both paths fail silently.

### FR-7: Delete ControlSurfaceProvider

After migration:
- Delete `web/src/hooks/use-control-surface.tsx`
- Remove `ControlSurfaceProvider` wrapper from `__root.tsx` `RootComponent`
- Delete `PiSessionContext` and `usePiSession` from `pi.route.tsx`

## Files Changed

```
web/src/
  router.tsx                              ← create clients, connect WS, pass in router context
  lib/settings-store.ts                   ← new: reactive settings store (tiny, useSyncExternalStore-compatible)
  hooks/use-control-surface.tsx           ← DELETE
  routes/__root.tsx                       ← expand context type, remove ControlSurfaceProvider wrapper
  routes/pi.route.tsx                     ← replace PiSessionContext with Outlet context, add send error surfacing
  routes/pi.default.tsx                   ← switch from usePiSession() to route context
  routes/pi.$sessionId.tsx                ← switch from usePiSession() to route context
  components/layout/AppShell.tsx          ← useRouteContext instead of useControlSurface
  components/layout/Sidebar.tsx           ← useRouteContext
  components/layout/SettingsDrawer.tsx    ← useSyncExternalStore for settings
  components/input-surface/InputSurface.tsx ← useRouteContext
  components/sessions/TranscriptViewer.tsx  ← useRouteContext
  components/sessions/SessionDetail.tsx     ← useRouteContext
  components/runtime/WhatsAppControls.tsx   ← useRouteContext
  routes/runtime.tsx                        ← useRouteContext
  routes/sessions.index.tsx                 ← useRouteContext
  routes/sessions.$sessionId.tsx            ← useRouteContext
  routes/sessions.workstream.$workstreamId.tsx ← useRouteContext
```

## Migration Order

1. **Create `settings-store.ts`** — reactive store, no React dependency.
2. **Extend `router.tsx`** — instantiate settings store + clients, connect WS, pass all into router context.
3. **Update `__root.tsx`** — expand context type, keep `ControlSurfaceProvider` temporarily as passthrough.
4. **Migrate consumers one by one** — switch each `useControlSurface()` call to `Route.useRouteContext()`. Each is a self-contained change.
5. **Migrate Pi session context** — replace `PiSessionContext` with `Outlet` context in `pi.route.tsx`, update `pi.default.tsx` and `pi.$sessionId.tsx`.
6. **Add send error surfacing** — update `sendMessage` in `pi.route.tsx`.
7. **Delete `ControlSurfaceProvider`** — remove from `__root.tsx`, delete file.

Steps 4 can be parallelized across files. Steps 1-3 must be sequential. Steps 5-7 depend on 4 completing for the Pi routes.

## Risks

1. **SSR hydration mismatch** — `wsClient` is a browser-only object (uses `WebSocket` API). On server, the client must exist but be inert — `connect()` should no-op when `typeof WebSocket === 'undefined'`. The current `AutonomaWsClient` already handles this (try/catch around `new WebSocket`).
2. **Settings drawer needs write access** — `updateSettings` must be in router context. Since router context is set at creation time, the callback must close over the mutable settings store, not a frozen snapshot.
3. **Outlet context typing** — TanStack Router's `Outlet` context is typed via generics. Child routes need correct type annotations to access Pi session state without `as` casts.
4. **Memory: settings store subscriber cleanup** — `useSyncExternalStore` handles cleanup automatically. No leak risk.
