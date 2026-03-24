# WebSocket Subscription Filtering

## Problem

Multiple PI agent sessions (default + workstream orchestrators) share a single WebSocket connection. Without filtering, every client receives every event — wasting bandwidth and requiring fragile client-side filtering by `sessionId`.

## How It Works

Clients send `subscribe`/`unsubscribe` messages to declare which sessions they care about. The server filters `broadcast()` so each client only receives events matching its subscriptions.

**Protocol messages** (client→server):
```
{ type: "subscribe", sessionId: string }
{ type: "unsubscribe", sessionId: string }
{ type: "ping" }
```

Server responds to `ping` with `{ type: "pong" }` (unicast to sender).

`sessionId: "*"` subscribes to all sessions (broadcast mode).

**Filtering rules** in `broadcast()`:
- Event has no `sessionId` field → global event, delivered to all clients
- Event has `sessionId` → delivered only to clients subscribed to that sessionId or `"*"`
- Client with zero subscriptions receives only global events

## Key Files

| File | Role |
|------|------|
| `src/ws/hub.ts` | `WebSocketHub` — per-client `subscriptions: Set<string>`, filtered `broadcast()`, `subscribeClient()`/`unsubscribeClient()` methods, RFC 6455 frame encode/decode |
| `src/contracts/websocket.ts` | Event type definitions; session-scoped events carry optional `sessionId`; includes `WebSocketClientPingEvent` and `PongWebSocketEvent` |
| `src/runtime.ts` | Handles incoming `subscribe`/`unsubscribe` messages from clients, routes to hub |
| `src/pi/session-manager.ts` | Broadcasts `queue_item_start`/`queue_item_end` with `sessionId` |
| `src/pi/subscribe.ts` | Subscribes to Pi session stream events (`text_delta`, `message_end`, `tool_execution_start/end`, `turn_end`) — all tagged with `sessionId` |

## Event Categories

**Session-scoped** (filtered by subscription): `queue_item_start`, `queue_item_end`, `text_delta`, `message_end`, `tool_execution_start`, `tool_execution_end`, `turn_end`, `pi_surfaced`

**Unicast** (sent directly to one client, not broadcast): `connected`, `pong`

**Global** (delivered to all via broadcast): `workstreams_changed`, `status_changed`

## Principles

- One WebSocket connection per client — subscriptions multiplex session interest over it
- Server-side filtering is authoritative; no client-side `sessionId` checks needed
- New session-scoped events must include `sessionId` in their payload or they'll broadcast globally

## Observations

- `connected` is unicast — sent via `send(clientId)`, not `broadcast()`. It never passes through subscription filtering.
- `broadcast()` wraps each `client.socket.write()` in try/catch. On write error, the dead client is removed and the loop continues for remaining clients.
