# Spec: WebSocket Subscribe Protocol

## Approach

Add a subscribe/unsubscribe protocol to the existing WebSocket connection so the server only forwards events matching each client's declared interests. Single spec — the change is cohesive and small enough to implement atomically.

## Functional Requirements

### FR-1: Subscribe/Unsubscribe Client Messages

The WebSocket accepts two new client→server message types:

- `{ type: "subscribe", sessionId: string }` — start receiving events for this session
- `{ type: "unsubscribe", sessionId: string }` — stop receiving events for this session

A client can hold multiple subscriptions simultaneously (e.g., subscribed to both default session and a workstream orchestrator).

The special value `"*"` subscribes to all sessions (broadcast mode). Useful for admin views. Unsubscribing `"*"` reverts to per-session filtering.

### FR-2: Per-Client Subscription State in Hub

Each `WebSocketClient` tracks a `subscriptions: Set<string>`. Initially empty (receives only global events).

- `subscribe(clientId, sessionId)` adds to the set
- `unsubscribe(clientId, sessionId)` removes from the set
- Subscription state is processed in `consumeFrames` when parsing incoming messages

### FR-3: Server-Side Filtered Broadcast

`broadcast(payload)` becomes filtering-aware:

- If the payload has no `sessionId` field → deliver to all clients (global event like `connected`)
- If the payload has a `sessionId` → deliver only to clients whose subscriptions include that `sessionId` or `"*"`

The existing `send(clientId, payload)` (unicast) remains unchanged — it bypasses subscription filtering.

### FR-4: Add sessionId to Events That Lack It

These event types currently lack `sessionId` and must gain it:

- `QueueItemStartWebSocketEvent` — add `sessionId?: string`
- `QueueItemEndWebSocketEvent` — add `sessionId?: string`
- `MessageQueuedWebSocketEvent` — add `sessionId?: string`
- `PiSurfacedWebSocketEvent` — add `sessionId?: string`

The emission sites in `runtime.ts` must thread the active session's ID into these payloads.

### FR-5: Frontend Subscribe on Session View

When `ChatPanel` mounts with a `piSessionId`:
1. Call `wsClient.subscribeSession(piSessionId)`
2. On unmount or `piSessionId` change, unsubscribe the previous session

`AutonomaWsClient` gains:
- `subscribeSession(sessionId: string)` — sends `{ type: "subscribe", sessionId }` over the socket
- `unsubscribeSession(sessionId: string)` — sends `{ type: "unsubscribe", sessionId }` over the socket

### FR-6: Remove Client-Side Session Filter

The `ChatPanel` filter block (lines ~123-132) that checks `message.sessionId !== piSessionId` is removed — the server now handles this.

### FR-7: Re-subscribe on Reconnect

When the WebSocket reconnects (after disconnect), the frontend must re-send all active `subscribe` messages. `AutonomaWsClient` tracks active subscriptions locally and replays them in the `onopen` handler.
