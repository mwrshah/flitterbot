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
