# Audit: WebSocket Message Hydration — streamId/streamName Gaps

## Summary

The DB load path works because it uses a `LEFT JOIN streams w ON w.id = m.stream_id` to resolve `stream_name` at query time. The WebSocket path relies on `currentItem` from `StreamSessionState` — which only carries streamId/streamName for **user** messages, and only when the QueueItem was properly populated before enqueue. Assistant messages get their streamId/streamName from `currentItem` too, but `subscribe.ts` explicitly gates this on `role === "user"` — so assistant messages emitted via `message_end` **never** carry streamId/streamName.

---

## 1. User Messages via WebSocket

### Trace

1. **Web UI sends message** → `handleWebSocketMessage()` (`runtime.ts:1556`)
2. **Classifier runs** → populates `routerMeta.stream_id` / `routerMeta.stream_name` (`runtime.ts:1578-1581`)
3. **`enqueue()`** is called (`runtime.ts:1589`) with metadata containing `stream_id` / `stream_name`
4. In `enqueue()` (`runtime.ts:252`):
   - The QueueItem is created **without** streamId/streamName (line 258-267)
   - The message is persisted to DB with `streamId` pulled from `input.metadata?.stream_id` (line 274)
   - After routing, `item.streamId` and `item.streamName` are set from `target.streamId` / `target.streamName` (lines 317-318)
5. **QueueItem enters TurnQueue** → `setBusy(true, item)` stores it in `StreamSessionState.currentItem` (`session-manager.ts:232`)
6. **subscribe.ts `message_end`** handler (`subscribe.ts:311-357`):
   - For `role === "user"`: reads `state.getSnapshot().currentItem` (line 326)
   - Sets `streamId: currentItem?.streamId` and `streamName: currentItem?.streamName` (lines 333-334)
   - Broadcasts both `message_end` and `stream_surfaced` events

### Verdict: PARTIALLY WORKS

- **When message is routed to a stream orchestrator** (matched by classifier): `resolveTargetSession` returns the orchestrator's `ManagedStreamSession` which has `streamId`/`streamName`. These get set on the QueueItem at line 317-318. Works.
- **When message goes to default session** (no stream match, or classifier fails): `target.streamId` is undefined on the default session. The QueueItem gets `streamId = undefined`. The `currentItem` in state has no streamId. **GAP: user message arrives on surface without streamId/streamName.**
- **DB persist path**: `enqueue()` at line 274 reads `stream_id` from `input.metadata?.stream_id` — this is the classifier's result, so it gets saved correctly to DB even when routing to default. But the WebSocket event doesn't use this value.

### Gap Detail

The disconnect: `enqueue()` persists `streamId` from metadata (classifier result), but sets `item.streamId` from `target.streamId` (routing destination). When routing goes to default (e.g. classifier says "create" which means default handles it), `target.streamId` is undefined even though `metadata.stream_id` exists.

---

## 2. Assistant Messages via WebSocket

### Trace

1. **SDK emits `message_end`** for assistant → `subscribe.ts:311`
2. `currentItem` lookup is **gated on role === "user"** (line 326):
   ```ts
   const currentItem = role === "user" ? state.getSnapshot().currentItem : undefined;
   ```
3. So for assistant messages: `streamId = undefined`, `streamName = undefined` — always.
4. The `ChatTimelineMessage` is built with no stream identity (lines 327-336)
5. For assistant role: broadcast as `message_end` with `intermediate: true` (line 339-346)
6. On `agent_end`: `broadcastSurfaced()` is called with `lastAssistantMessage` (line 427)
7. `broadcastSurfaced()` reads `message.streamId` and `message.streamName` from the ChatTimelineMessage (lines 131-132) — but these are undefined because step 2 filtered them out.

### Verdict: BROKEN

Assistant messages **never** have streamId/streamName on the WebSocket path. The `broadcastSurfaced()` function at line 122-135 does:
```ts
streamId: message.streamId,    // undefined
streamName: message.streamName, // undefined
```

### DB path comparison

The DB load path (`browser-streams.ts:117-129`) calls `getInputSurfaceHistory()` which does:
```sql
SELECT m.*, w.name AS stream_name FROM messages m LEFT JOIN streams w ON w.id = m.stream_id
```

The assistant message is persisted in `processQueueItem()` at `runtime.ts:787-794`:
```ts
const streamId = managed.streamId ?? (item.metadata?.stream_id as string) ?? undefined;
persistOutboundMessage(this.blackboard, {
  source: "stream_outbound",
  streamId,
  streamSessionId: managed.streamSessionId,
});
```

So the DB row has `stream_id` set correctly (from `managed.streamId` of the orchestrator). The `LEFT JOIN` resolves `stream_name`. This is why reload fixes the surface display.

---

## 3. stream_id Saving Audit — All Code Paths

### Path A: User messages stream directly (routed to orchestrator)

| Step | DB | WebSocket |
|------|-----|-----------|
| Persist in `enqueue()` (line 278) | stream_id = metadata.stream_id | N/A |
| QueueItem after routing (line 317-318) | N/A | streamId = target.streamId |
| WS `message_end` emission | N/A | streamId = currentItem.streamId |

**DB**: stream_id saved from classifier metadata.
**WS**: streamId present — `target.streamId` is set because routing went to orchestrator.

### Path B: User message routed to default, stream assigned by AI (create_stream tool)

| Step | DB | WebSocket |
|------|-----|-----------|
| Persist in `enqueue()` (line 278) | stream_id = undefined (no classifier match) | N/A |
| QueueItem after routing (line 317-318) | N/A | streamId = undefined (default has no streamId) |
| WS `message_end` emission | N/A | streamId = undefined |
| AI calls create_stream, re-enqueues to orchestrator (line 1096) | stream_id in metadata | streamId/streamName set from metadata in new QueueItem |

**DB**: The original user message has no stream_id. The re-enqueued message to the orchestrator does.
**WS**: The original user `message_end` has no streamId. The re-enqueued prompt to the orchestrator triggers a new user `message_end` with streamId.

### Path C: Assistant messages (stream_surfaced)

| Step | DB | WebSocket |
|------|-----|-----------|
| Persist in `processQueueItem()` (line 787-794) | stream_id = managed.streamId | N/A |
| WS `message_end` (line 338-346) | N/A | streamId = undefined (filtered by role check) |
| WS `stream_surfaced` (line 427) | N/A | streamId = lastAssistantMessage.streamId = undefined |

**DB**: stream_id correctly saved from orchestrator's `managed.streamId`.
**WS**: streamId always undefined for assistant messages.

### Path D: enqueue_message tool (agent → stream)

| Step | DB | WebSocket |
|------|-----|-----------|
| Persist (line 1207-1218) | stream_id = ws.id | N/A |
| QueueItem (line 1184-1192) | N/A | metadata has stream_id/stream_name |
| WS user `message_end` | N/A | Depends on orchestrator's currentItem |

**DB**: Correct.
**WS**: QueueItem metadata has stream info, and since it's enqueued on the orchestrator which has streamId/streamName, it works.

---

## Root Cause

Two distinct bugs:

### Bug 1: Assistant messages never get stream identity on WS

`subscribe.ts:326` explicitly excludes assistant messages from getting `currentItem`:
```ts
const currentItem = role === "user" ? state.getSnapshot().currentItem : undefined;
```

The `ManagedStreamSession` that owns the subscription already knows its `streamId`/`streamName`, but `subscribeToStreamSession()` doesn't receive or use them.

### Bug 2: User messages to default session lose stream identity on WS

When the classifier identifies a stream but routing still goes to default (e.g. action is "create"), `target.streamId` is undefined because the default session has no stream. The classifier's `stream_id` is in metadata but not used for the WS event.

---

## Proposed Fix: Attach Stream Identity at Creation

The simplest single-source-of-truth approach:

### For assistant messages

`subscribeToStreamSession()` already receives `state` (StreamSessionState). The managed session knows its streamId/streamName. Pass them into the subscribe function:

```
subscribeToStreamSession(session, state, blackboard, wsHub, streamId, streamName)
```

In the `message_end` handler, always attach these for messages from stream-owning sessions:
```ts
const timelineMessage: ChatTimelineMessage = {
  ...
  streamId: (role === "user" ? currentItem?.streamId : undefined) ?? sessionStreamId,
  streamName: (role === "user" ? currentItem?.streamName : undefined) ?? sessionStreamName,
};
```

This way:
- User messages get streamId from the QueueItem (already works for routed messages)
- Assistant messages get streamId from the session's own identity
- Default session has no streamId, so default-session messages correctly get undefined

### For user messages in default session

In `enqueue()`, after the QueueItem is created but before persisting, resolve streamId from metadata when it exists:

```ts
// Already on line 274:
const streamId = (input.metadata?.stream_id as string) ?? undefined;
// Add: also set on the item for WS path
item.streamId = item.streamId ?? streamId;
item.streamName = item.streamName ?? (input.metadata?.stream_name as string) ?? undefined;
```

Move these assignments to happen before routing, so even default-routed messages carry the classifier's stream identity.

### Why this is the right fix

1. **No fallbacks or left joins needed** — stream identity is attached at the source (session identity for assistant, QueueItem for user)
2. **Single source of truth** — each message gets its stream identity from the entity that knows it: the orchestrator session for its own messages, the classifier/router for user messages
3. **Minimal change surface** — two files: `subscribe.ts` (pass + use session stream identity) and `runtime.ts` (set streamId/streamName on QueueItem from metadata earlier)
4. **No DB schema changes** — the DB already stores stream_id correctly; this fixes only the WS emission path
