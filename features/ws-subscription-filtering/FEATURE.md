# WebSocket Subscription Filtering

## Problem

Multiple PI agent sessions (default + workstream orchestrators) share a single WebSocket connection. Without filtering, every client receives every event — wasting bandwidth and requiring fragile client-side filtering by `sessionId`.

## How It Works

Clients send `subscribe`/`unsubscribe` messages to declare which sessions they care about. The server filters `broadcast()` so each client only receives events matching its subscriptions.

**Protocol messages** (client→server):
```
{ type: "subscribe", sessionId: string }
{ type: "unsubscribe", sessionId: string }
```

`sessionId: "*"` subscribes to all sessions (broadcast mode).

**Filtering rules** in `broadcast()`:
- Event has no `sessionId` field → global event, delivered to all clients
- Event has `sessionId` → delivered only to clients subscribed to that sessionId or `"*"`
- Client with zero subscriptions receives only global events

## Key Files

| File | Role |
|------|------|
| `src/ws/hub.ts` | `WebSocketHub` — per-client `subscriptions: Set<string>`, filtered `broadcast()`, `subscribeClient()`/`unsubscribeClient()` methods, RFC 6455 frame encode/decode |
| `src/contracts/websocket.ts` | Event type definitions; session-scoped events carry optional `sessionId` |
| `src/runtime.ts` | Handles incoming `subscribe`/`unsubscribe` messages from clients, routes to hub |
| `src/pi/session-manager.ts` | Broadcasts `queue_item_start`/`queue_item_end` with `sessionId` |
| `src/pi/subscribe.ts` | Subscribes to Pi session stream events (`text_delta`, `message_end`, `tool_execution_start/end`, `turn_end`) — all tagged with `sessionId` |

## Event Categories

**Session-scoped** (filtered by subscription): `queue_item_start`, `queue_item_end`, `text_delta`, `message_end`, `tool_execution_start`, `tool_execution_end`, `turn_end`, `pi_surfaced`

**Global** (delivered to all): `connected`, `workstreams_changed`, `status_changed`

## Principles

- One WebSocket connection per client — subscriptions multiplex session interest over it
- Server-side filtering is authoritative; no client-side `sessionId` checks needed
- New session-scoped events must include `sessionId` in their payload or they'll broadcast globally

## Observations

- **attention!** `connected` is listed as a global event, but it's actually unicast — sent via `send(clientId)`, not `broadcast()`. It never passes through subscription filtering. Harmless, but the mental model "global = broadcast to all" doesn't apply here.
- **attention!** `as any` casts throughout the WS broadcasting path: `hub.ts:87` casts the payload to extract `sessionId`, `session-manager.ts:283,307` cast `queue_item_start`/`queue_item_end` payloads, `runtime.ts:1258-1263` casts subscribe/unsubscribe payloads to access `sessionId`. All are unnecessary — TypeScript narrowing and the existing interface definitions cover these cases. The casts suppress type errors that would catch contract drift.
- **attention!** `broadcast()` in `hub.ts:89-101` calls `client.socket.write(frame)` with no error handling. If a client socket is broken but the `close`/`error` event hasn't fired yet, `write()` throws and crashes the broadcast loop — remaining clients don't receive the event.
- **TBD!** `WorkstreamsChangedWebSocketEvent.reason` includes `"reopened"` in its union (`contracts/websocket.ts:126`), but no code path ever emits this reason. Dead variant — either implement workstream reopening or remove it from the type.
