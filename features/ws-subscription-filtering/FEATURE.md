# WebSocket Subscription Filtering

## Problem

All WebSocket events are broadcast to every connected client. When multiple PI agent sessions exist (default + workstream orchestrators), every ChatPanel receives every event. The frontend filters by `sessionId` where available, but:

1. Not all event types carry `sessionId` (e.g., `queue_item_start`, `message_queued`, `pi_surfaced`)
2. Even when filtered, all data still traverses the wire — wasted bandwidth
3. The frontend filter is fragile — new event types must remember to include `sessionId` or they leak

## Goals

- Single WebSocket connection per client (no reconnect-per-page)
- Client declares which session(s) it wants via `subscribe`/`unsubscribe` messages on the existing connection
- Server-side filtering: only forward events matching the client's active subscriptions
- Global events (e.g., `connected`) always delivered regardless of subscription
- Clean semantics: subscribe to a `sessionId`, receive all events tagged with that session

## Architecture

### Protocol Addition

Two new client→server message types on the existing WebSocket:

```
{ type: "subscribe", sessionId: string }
{ type: "unsubscribe", sessionId: string }
```

A special sessionId value `"*"` means "all sessions" (current broadcast behavior, useful for admin/debug views).

### Server Changes

- **`WebSocketHub`** (`src/control-surface/ws/hub.ts`): Each `WebSocketClient` gains a `subscriptions: Set<string>` field. New methods: `subscribe(clientId, sessionId)`, `unsubscribe(clientId, sessionId)`. The `broadcast()` method becomes subscription-aware — it checks each client's subscriptions before writing.
- **`subscribe.ts`** (`src/control-surface/pi/subscribe.ts`): No change — it already tags every event with `sessionId`. The hub handles filtering.
- **Events without `sessionId`**: `queue_item_start`, `queue_item_end`, `message_queued`, `pi_surfaced` need a `sessionId` added to their payloads so the hub can filter them. This requires threading `sessionId` through to where these events are emitted.
- **Contracts** (`src/contracts/websocket.ts`): Add `subscribe`/`unsubscribe` to client event union. Add `sessionId` to event types that lack it.

### Frontend Changes

- **`AutonomaWsClient`** (`web/src/lib/ws.ts`): Add `subscribeSession(sessionId)` and `unsubscribeSession(sessionId)` methods that send the protocol messages.
- **`ChatPanel`** (`web/src/components/chat/ChatPanel.tsx`): On mount, call `wsClient.subscribeSession(piSessionId)`. On unmount/session change, unsubscribe the old session. Remove the client-side `sessionId` filter — the server now handles it.
- **Default behavior**: If no `subscribe` messages have been sent, the client receives nothing (except global events). The frontend must explicitly subscribe on connect.

### Files Touched

| File | Change |
|------|--------|
| `src/contracts/websocket.ts` | Add subscribe/unsubscribe client events; add `sessionId` to queue/surfaced events |
| `src/control-surface/ws/hub.ts` | Per-client subscription tracking; filtered broadcast |
| `src/control-surface/pi/subscribe.ts` | No change (already tags sessionId) |
| `src/control-surface/runtime.ts` | Thread sessionId into queue_item_start/end emissions |
| `web/src/lib/ws.ts` | subscribeSession/unsubscribeSession methods |
| `web/src/lib/types.ts` | Update WsMessage type for new client events |
| `web/src/components/chat/ChatPanel.tsx` | Subscribe on mount, remove client-side filter |
