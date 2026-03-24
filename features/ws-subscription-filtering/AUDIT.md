# WebSocket Subscription Filtering — Audit Report

Audited 2026-03-24 against actual codebase state.

## Matches

- **Protocol messages** — `subscribe` and `unsubscribe` client event types defined in `contracts/websocket.ts:18-30` with `{ type, sessionId }` shape exactly as documented
- **Wildcard `"*"` subscription** — `hub.ts:98` checks `client.subscriptions.has("*")` as documented
- **Filtering rules in `broadcast()`** — `hub.ts:85-101` implements all three rules: no `sessionId` → deliver to all; has `sessionId` → deliver only to subscribed or wildcard clients; zero subscriptions → skip (only global events reach them)
- **Per-client `subscriptions: Set<string>`** — `hub.ts:15` on `WebSocketClient` type
- **`subscribeClient()` / `unsubscribeClient()` methods** — `hub.ts:112-120`
- **`runtime.ts` handles subscribe/unsubscribe** — lines 1295-1301 route incoming client messages to hub methods
- **Session-scoped events carry `sessionId`** — confirmed in `subscribe.ts` (text_delta, message_end, tool_execution_start/end, turn_end) and `session-manager.ts` (queue_item_start, queue_item_end)
- **`pi_surfaced` carries `sessionId`** — `runtime.ts:693-697`
- **Global events have no `sessionId`** — `workstreams_changed` (`runtime.ts:861,1087`) and `status_changed` (`runtime.ts:1200`) confirmed to lack `sessionId`
- **`connected` is unicast** — sent via `hub.send(client.id, ...)` at `hub.ts:81`, not `broadcast()`
- **`broadcast()` error handling** — `safeWrite()` at `hub.ts:104-110` wraps `socket.write()` in try/catch, removes dead clients on error
- **RFC 6455 frame encode/decode** — `hub.ts:172-238` implements raw WebSocket framing (text frames, ping/pong, close, masking, multi-byte length)
- **Key files table** — all 5 files listed exist at the documented paths with the documented roles

## Divergences

| Area | Doc says | Actual |
|---|---|---|
| `send()` error handling | Doc implies broadcast-only try/catch: "`broadcast()` wraps each `client.socket.write()` in try/catch" | `send()` (`hub.ts:122-126`) does NOT wrap in try/catch — only `broadcast()` uses `safeWrite()`. A write error on unicast `send()` would throw uncaught. |
| `message_end` intermediate flag | Not mentioned in event categories | `subscribe.ts:204-213` implements deferred assistant message batching — earlier messages in a turn get `intermediate: true`, only the last is final. This is a significant filtering behavior not covered in the doc. |

## Missing from Doc

- **`agent_end` event type** — `subscribe.ts:43,132` treats `agent_end` the same as `turn_end` (no blackboard touch, triggers deferred message flush). Not documented anywhere.
- **Deferred assistant message batching** — `subscribe.ts:126,168-173,204-214` accumulates assistant `message_end` events during a turn and flushes them on `turn_end` with intermediate markers. This is a non-trivial broadcast behavior not mentioned in the feature doc.
- **`pi_surfaced` fields** — the actual broadcast (`runtime.ts:692-699`) includes `workstreamId` and `workstreamName`, not mentioned in the doc's event categories.
- **`message_end` extra fields** — the type (`websocket.ts:69-83`) includes `messageId`, `source`, `timestamp`, `intermediate`, `workstreamId`, `workstreamName` beyond what the doc's event category list implies.
- **`queue_item_start`/`queue_item_end` carry `workstreamId`** — `session-manager.ts:282,306` conditionally includes `workstreamId`, not documented.
- **Ping/pong handling** — `hub.ts:149-151` responds to WebSocket ping frames with pong. Not mentioned in doc.
- **Close frame handling** — `hub.ts:144-148` handles opcode 0x8 (close), removes client. Not mentioned.
- **Token auth on upgrade** — `hub.ts:36-44` validates bearer token or query param token on WebSocket upgrade. Not documented in this feature (may belong elsewhere).

## Missing from Implementation

No gaps found — all documented behaviors are implemented as described.
