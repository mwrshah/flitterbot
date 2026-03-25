# Server-Side Streaming Audit

Audit of the text delta delivery path from AI model response to WebSocket client.

---

## 1. Exact Code Path: Text Delta to WebSocket Send

The chain has **4 hops** with zero intermediate buffering for deltas:

```
Pi SDK event (text_delta)
  → subscribe.ts:97   — event listener fires synchronously
  → subscribe.ts:102  — broadcast() called immediately
  → hub.ts:85         — broadcast() encodes frame, iterates clients
  → hub.ts:106        — socket.write() per subscribed client
```

**Detailed walkthrough:**

1. **Pi SDK emits `message_update` event** during `session.prompt()` streaming. The event contains `assistantMessageEvent.type === "text_delta"` with the raw delta string.

2. **`subscribeToPiSession()` listener** (`src/pi/subscribe.ts:87`) fires synchronously for each event. At line 97, it matches `message_update` → `text_delta`.

3. **UUID pre-allocation** (`subscribe.ts:99-101`): On the first delta of a new message, `crypto.randomUUID()` generates a server-side message ID. Subsequent deltas reuse it. This is the only per-delta computation beyond the broadcast itself.

4. **`broadcast()` wrapper** (`subscribe.ts:24-26`): A trivial pass-through to `wsHub.broadcast()`.

5. **`WebSocketHub.broadcast()`** (`ws/hub.ts:85-102`):
   - Line 88: `JSON.stringify(payload)` + `encodeFrame()` — done **once** per broadcast, reused for all clients
   - Lines 89-101: Iterate all connected clients, filter by subscription match, call `safeWrite()`

6. **`safeWrite()`** (`ws/hub.ts:104-110`): Calls `client.socket.write(frame)` directly on the raw TCP socket. No queuing, no callback waiting.

**Total async boundaries: zero.** The entire path from Pi SDK event to socket.write is synchronous. The `subscribe` callback is invoked synchronously by the SDK, `broadcast` is synchronous, `socket.write` is a non-blocking kernel call.

---

## 2. Batching, Debouncing, or Buffering

**None for `text_delta` events.** Each delta is broadcast the instant it arrives.

There **is** intentional deferral for `message_end` events (assistant role only):

- `subscribe.ts:80`: `pendingAssistantMessages: MessageEndWebSocketEvent[]` accumulates assistant message_end events during a turn.
- `subscribe.ts:155-157`: Assistant message_end events are pushed to this array instead of being broadcast.
- `subscribe.ts:228-237`: Flushed only on `turn_end` (when `stopReason !== "toolUse"`). All but the last are marked `intermediate: true`.

This deferral does **not** affect streaming text — deltas flow immediately. It only affects the final `message_end` summary event.

---

## 3. Individual vs. Aggregated Chunks

**Individual.** Each `text_delta` from the Pi SDK becomes exactly one WebSocket frame. There is no coalescing, batching window, or minimum chunk size.

The frame is encoded once (`hub.ts:88`) and written to every matching client socket. For N subscribed clients, there are N `socket.write()` calls sharing the same pre-encoded Buffer.

---

## 4. Message Format Efficiency

### text_delta payload (the hot path)

```json
{
  "type": "text_delta",
  "sessionId": "uuid-string",
  "messageId": "uuid-string",
  "delta": "the actual text chunk"
}
```

**Overhead analysis:**
- Fixed JSON envelope: ~90 bytes (`{"type":"text_delta","sessionId":"<36>","messageId":"<36>","delta":""}`)
- Typical Claude delta: 1-20 characters of text
- **Overhead ratio: ~5:1 to ~90:1** (envelope vs. payload) for small deltas

This is standard for JSON-over-WebSocket. The envelope size is dominated by the two UUIDs (72 chars). If streaming latency becomes critical, these could be shortened (e.g., session index instead of full UUID), but the overhead is unlikely to be the bottleneck compared to network RTT.

### WebSocket frame encoding (`hub.ts:172-189`)

Standard RFC 6455 text frames. For messages under 126 bytes (which covers most text_delta payloads), the frame header is just 2 bytes. Efficient.

### Other event types on the wire

| Event | Relative size | Frequency |
|-------|--------------|-----------|
| `text_delta` | Small (~100-150B) | Every delta (high frequency) |
| `tool_execution_start` | Medium (~200-500B) | Includes full `args` and raw `event` object |
| `tool_execution_end` | Large (unbounded) | Includes full `result` and raw `event` object |
| `message_end` | Medium (~200-500B) | Once per message |
| `turn_end` | Large (unbounded) | Includes raw `event` object |

**Concern:** `tool_execution_start`, `tool_execution_end`, and `turn_end` events include the raw SDK `event` object (`subscribe.ts:183, 209, 246`). These can be large (tool results may contain file contents, command output, etc.). This doesn't affect delta streaming latency directly, but large frames could create head-of-line blocking on the socket if they coincide with rapid delta delivery.

---

## 5. Unnecessary Async Boundaries

**The delta path has none.** All operations are synchronous:

- `subscribe.ts:87`: The `session.subscribe()` callback is synchronous
- `subscribe.ts:102-107`: `broadcast()` is synchronous
- `hub.ts:85-102`: `broadcast()` iterates clients synchronously
- `hub.ts:106`: `socket.write()` is non-blocking (returns immediately, kernel buffers)

The only `async` code in `hub.ts` is `consumeFrames()` (line 139) for **inbound** frame processing, which calls `await this.onMessage?.()`. This is on the receive path, not the send path, so it doesn't affect delta delivery latency.

**Confirmed concern:** `touchPiEvent()` is called at `subscribe.ts:92` before the switch statement. It executes a **synchronous SQLite UPDATE** on every event including every text_delta:

```sql
-- write-pi-sessions.ts:146-153
UPDATE pi_sessions
SET last_event_at = MAX(last_event_at, ?),
    status = ?,
    ended_at = NULL,
    end_reason = NULL
WHERE pi_session_id = ?
```

This is a synchronous `db.prepare(...).run()` call (better-sqlite3 is synchronous). Each text_delta triggers a disk write before the broadcast. For a typical Claude response with 50-200 deltas, this is 50-200 SQLite writes that add latency to the streaming path. The write itself is fast (sub-millisecond for WAL mode), but it's unnecessary overhead on the hot path — the status doesn't meaningfully change between consecutive deltas.

---

## 6. Backpressure Handling

**There is effectively none.**

### Current behavior:

- `safeWrite()` (`hub.ts:104-110`): Calls `socket.write(frame)` without checking the return value. `socket.write()` returns `false` when the kernel buffer is full (backpressure signal), but this is ignored.
- No `drain` event listener — if `write()` returns `false`, the code never waits for the buffer to drain before writing more.
- No write queue, no high-water mark, no per-client rate limiting.

### What happens with a slow client:

1. `socket.write()` calls accumulate data in the Node.js internal write buffer
2. Node.js buffers grow without bound (no `highWaterMark` set on the raw socket)
3. Eventually, either:
   - The client catches up (buffer drains naturally)
   - The OS kills the connection (TCP timeout)
   - The process runs out of memory (extreme case with many slow clients)

### Error path:

- `safeWrite()` catches write exceptions → deletes the client from the map (aggressive disconnect)
- `send()` (`hub.ts:122-126`) has **no** error handling — exceptions propagate to caller

### Risk assessment:

For a local control surface with 1-3 connected browser tabs, this is fine. The clients are on localhost with negligible latency. For remote clients over slow connections, this could become problematic.

---

## Summary of Findings

| Question | Finding |
|----------|---------|
| **Delta → WS path** | 4 synchronous hops, zero async boundaries |
| **Batching/buffering** | None for deltas. Assistant message_end deferred until turn_end |
| **Chunk granularity** | 1:1 — each SDK delta = one WS frame |
| **Message format** | ~90 byte JSON envelope per delta. Functional but not minimal |
| **Async overhead** | None on send path. But synchronous SQLite write (`touchPiEvent`) on every delta |
| **Backpressure** | None. socket.write() return value ignored, no drain handling |

### Potential optimizations (not necessarily recommended):

1. **`touchPiEvent()` on hot path** — If this writes to SQLite on every delta, consider throttling or batching DB touches.
2. **Raw event objects in tool/turn events** — `event` field on `tool_execution_start/end` and `turn_end` can be large. Consider omitting or summarizing.
3. **Backpressure** — Add `drain` event handling if remote clients are ever supported.
4. **`send()` error handling** — `hub.ts:125` lacks the try-catch that `safeWrite()` has. A broken socket on direct `send()` will throw.

### What's working well:

- Zero-copy frame reuse across broadcast recipients (`hub.ts:88`)
- Synchronous hot path — no unnecessary promises or event loop ticks between delta and socket write
- Subscription-based filtering avoids sending to uninterested clients
- UUID pre-allocation avoids per-delta allocation after the first delta
