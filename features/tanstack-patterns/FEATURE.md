# TanStack Patterns For WS Subscriptions

## Problem

WebSocket subscription ownership should not live in route component effects. The active screen is a router concern, not a view concern, and the subscription mode depends on resolved route state:

- `/` wants wildcard subscription with a narrow surfaced event set
- `/pi/default` wants the real default Pi session id, not the literal string `"default"`
- `/pi/$sessionId` wants the exact route param session id

Putting subscribe/unsubscribe inside React effects couples transport behavior to mount/unmount behavior and makes debugging noisy.

## Goal

Use TanStack Router / Start primitives for route-driven subscription policy:

- route metadata declares subscription mode
- route loaders resolve dynamic ids
- one central router-owned subscriber applies the effective WS subscription after navigation resolves

## Architecture

### 1. Route metadata declares intent

Each route exposes static metadata describing what kind of subscription it needs.

Examples:

- `/` → `wsMode: "input-surface"`
- `/pi/default` → `wsMode: "pi-default"`
- `/pi/$sessionId` → `wsMode: "pi-session"`

This is synchronous route information, so it belongs in TanStack route metadata rather than in component logic.

### 2. Loaders resolve dynamic values

The `/pi/default` route loader resolves the actual default Pi session id from status data. The `/pi/$sessionId` route already has the explicit session id in params.

Loaders produce data. They should not imperatively mutate the browser WebSocket state.

### 3. Router owns the side effect

`router.subscribe("onResolved", ...)` becomes the single owner of subscription changes. After navigation resolves, it reads:

- the active matches
- their static metadata
- any needed loader data

and computes exactly one desired WS subscription state for the current screen.

### 4. WS client stays transport-focused

The WS client exposes imperative methods like:

- `subscribeSession(sessionId, eventTypes?)`
- `unsubscribeSession(sessionId)`

It should not infer route meaning by itself. The router tells it what the app currently needs.

## Effective Subscription Policy

### Input Surface

Subscribe to:

- `sessionId: "*"`
- `eventTypes: ["message_end", "pi_surfaced"]`

This keeps the input surface lightweight: user messages plus surfaced final assistant responses.

### Pi Default

Subscribe to:

- `sessionId: <resolved default Pi session id>`
- no event filter, meaning all events for that session

This enables full streaming for the actual default Pi conversation.

### Pi Session

Subscribe to:

- `sessionId: params.sessionId`
- no event filter

This enables full streaming for an explicit Pi session route.

## Why This Pattern

- It matches TanStack’s strengths: route metadata, loaders, and router lifecycle.
- It removes transport ownership from presentation components.
- It avoids coupling WS traffic to React component mount semantics.
- It makes the active subscription derivable from router state alone.

## Boundary

TanStack loaders and `beforeLoad` are for data and route resolution. The actual subscribe/unsubscribe side effect should happen only after the router resolves the active route on the client.

## WS-Driven Query Cache Pattern

### The Problem

WS-driven queries like pi-history are kept live via `setQueryData` while the user is viewing the route. But when the user navigates away, the router-owned subscriber unsubscribes from that session's WS events. The cache silently goes stale with no mechanism to signal this to TanStack Query.

Using `staleTime: Infinity` masks this — the cache reports fresh data indefinitely, even after the WS stops updating it. This forces manual cache manipulation (removeQueries, invalidateQueries) on route leave to work around the lie, defeating the purpose of having a cache.

### The Pattern: staleTime 0 + WS setQueryData

Use `staleTime: 0` so data is considered stale unless it was just updated. The WS lifecycle handles freshness naturally through three phases:

**While viewing** — WS `setQueryData` calls reset `dataUpdatedAt` on every event. Since data was just updated, useQuery observers see it as fresh and do not refetch. The cache is genuinely live.

**On route leave** — The router-owned subscriber unsubscribes from WS events. No more `setQueryData` calls means `dataUpdatedAt` stops advancing, and the data becomes stale naturally. No manual cache manipulation needed.

**On return (revalidation and rehydration)** — This is where stale-while-revalidate pays off:

1. `ensureQueryData` in the route loader finds cached data and returns it instantly. The user sees the last-known messages with zero delay.
2. `useQuery` mounts in the component, sees the data is stale (`staleTime: 0`), and triggers a background HTTP fetch to the server.
3. The server queries the DB for the full message history for that session and returns it.
4. TanStack Query replaces the stale cache with the fresh server response. The `structuralSharing` merge function reconciles any WS-accumulated items that the server might not have yet — preventing oscillation where server data temporarily replaces items that only exist via `setQueryData`.
5. The UI re-renders with the fresh, complete message history — rehydrated from the DB.
6. Simultaneously, the WS resubscribes to that session's events, so any new messages arriving after the fetch are pushed live.

The user experience: cached messages appear instantly on navigation, then within milliseconds the data is rehydrated from the database. No spinner, no flash of empty state.

Both the pi session routes (`/pi/$sessionId`) and the input surface route (`/`) use this pattern. The input surface follows the same `staleTime: 0` + `ensureQueryData` approach — its wildcard WS subscription keeps the cache live while viewing, and on return the stale cache is served instantly while a background refetch rehydrates from the server.

### What Changed

- **`piHistoryQueryOptions`**: `staleTime: Infinity` → `staleTime: 0`. Lets TanStack Query see staleness naturally instead of hiding it.
- **`ws-route-subscriptions.ts`**: Removed the `removeQueries` call that nuked the cache on every route leave. This was a workaround for `staleTime: Infinity` — without it, `ensureQueryData` would return stale data that looked fresh, so the only option was to destroy the cache entirely and force a blocking refetch. That workaround caused loading spinners on return. With `staleTime: 0`, staleness is visible to TanStack Query and the standard revalidation path handles it.

### Anti-Patterns

- **`staleTime: Infinity` for WS-driven data** — hides staleness and forces imperative cache manipulation on route transitions. The cache reports fresh data that is actually stale.
- **`removeQueries` / `invalidateQueries` on route leave** — nukes the cache entirely, causing loading spinners on return instead of instant cached responses with background revalidation.
- **`fetchQuery` in loaders for cached data** — blocks navigation waiting for a network response when cached data would serve the user instantly.

### When staleTime Infinity Is Correct

`staleTime: Infinity` is appropriate for data that is never fetched from the server and is purely managed via `setQueryData` with no subscription lifecycle. Examples: connection-state, status-pills. These are application-global state stored in the query cache for convenience — no route-scoped WS subscription starts or stops updating them, so staleness is not a concern.
