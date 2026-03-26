# WebSocket Duplicate Emit Investigation

## Summary

The recent fixes (f330be7, 97da32e, 2d5d021) addressed **connection-level** duplicates effectively — the state machine, guards, and cleanup in `AutonomaWsClient` are solid. The remaining duplicates stem from **message-level** issues: the same logical content appearing twice in the UI timeline due to overlapping emit paths and missing deduplication in the store.

---

## Root Causes

### 1. `message_end` + `pi_surfaced` dual-emit (HIGH confidence)

**The same assistant message is broadcast twice via two separate server-side code paths.**

- Path A: `src/pi/subscribe.ts:259-267` — deferred `message_end` flushed on `turn_end`, with a server-generated UUID as `messageId`
- Path B: `src/runtime.ts:683-691` — `pi_surfaced` broadcast after turn completes, resolving the agent's message ID to a server UUID via `resolveServerId()`

The frontend handler in `web/src/hooks/use-pi-ws-handler.ts` has a dedup check for `pi_surfaced` (line 148: `s.appendedItems.some(item => item.id === message.messageId)`), which works **only when** the agent message has an `id` field that maps to the same server UUID.

**Failure mode**: When the agent message lacks an `id` field:
- `subscribe.ts:167` — `agentMessageId = extractMessageId(event.message)` → `undefined`
- `subscribe.ts:182` — `if (agentMessageId)` → skip, no mapping inserted
- `runtime.ts:650-652` — `finalMessageId` is `undefined` → `resolvedMessageId = crypto.randomUUID()` (NEW random UUID)
- Result: `message_end.messageId ≠ pi_surfaced.messageId` → dedup fails → **duplicate content in UI**

### 2. Non-deterministic tool event IDs (MEDIUM confidence)

**Tool events in WS can get random IDs that don't match history IDs, causing duplicates after route reloads.**

In `src/pi/subscribe.ts:216-218`:
```
deterministicId = toolCallId && lastAssistantId
    ? `${lastAssistantId}:tool:${toolCallId}:start`
    : undefined;
```

When `lastAssistantId` is undefined (no pending assistant messages when tool fires), `deterministicId` is undefined. The frontend (`use-pi-ws-handler.ts:176`) falls back to `createId("tool")` — a random ID.

The history API (`src/pi/history.ts:151-153`) always generates deterministic IDs: `${resolvedId}:tool:${toolCallId}:start`.

After a reconnect, `router.invalidate()` refetches history. `mergeTimelines()` dedupes by ID, but the WS random ID ≠ history deterministic ID → **duplicate tool items**.

### 3. No store-level dedup on `appendedItems` (MEDIUM confidence)

**The piSessionStore blindly appends items without checking for existing IDs.**

In `use-pi-ws-handler.ts`, all event types except `pi_surfaced` append to `appendedItems` without ID dedup:
- `text_delta` (line 89): updates streaming text — not an append, so fine
- `message_end` (line 102/121): appends to `appendedItems` — **no dedup check**
- `tool_execution_start/end` (line 198): appends to `appendedItems` — **no dedup check**
- `turn_end` (line 210): appends divider — uses `createId()` so unique by construction

This means if the same `message_end` event is somehow processed twice (e.g., during reconnect overlaps), it would appear twice. The `mergeTimelines` dedup in the route component catches history↔WS overlaps, but NOT WS↔WS overlaps within `appendedItems` itself.

### 4. `resetPiSessionStore` / `useSyncExternalStore` identity mismatch (LOW confidence)

In `use-pi-ws-handler.ts:26-28`, `resetPiSessionStore()` replaces the module-level singleton. But `usePiSessionStore()` passes the old store's `.subscribe` and `.getSnapshot` to `useSyncExternalStore`. Until components re-render, they're subscribed to the old (empty) store while the WS handler writes to the new store. This is primarily a **data loss** issue (not duplicate), but the re-render cascade could cause items to flash or appear to duplicate if the transition isn't clean.

---

## Code Locations

| File | Line(s) | Role |
|------|---------|------|
| `web/src/lib/ws.ts` | 29-303 | WS client with state machine (well-guarded) |
| `web/src/hooks/use-pi-ws-handler.ts` | 39-240 | WS→store handler — missing dedup on most event types |
| `web/src/lib/pi-session-store.ts` | 58-63 | `updateSession` — blind append, no ID dedup |
| `web/src/lib/utils.ts` | 78-86 | `mergeTimelines` — dedupes history↔WS by ID |
| `web/src/routes/__root.tsx` | 103-112 | Reconnect → `router.invalidate()` triggers history refetch |
| `src/pi/subscribe.ts` | 159-208 | Server-side event→WS bridge — inserts ID mappings |
| `src/runtime.ts` | 644-697 | `pi_surfaced` emission — can generate mismatched UUID |
| `src/pi/history.ts` | 149-153 | Deterministic tool IDs in history |
| `web/src/router.tsx` | 14-17 | Settings change triggers `wsClient.reconnect()` |

---

## Recommended Fixes

### Fix 1: Add ID-based dedup to piSessionStore `updateSession` (addresses #3, hardens all paths)

In `use-pi-ws-handler.ts`, before appending any item, check if an item with the same `id` already exists in `appendedItems`:

```ts
// For message_end, tool events, etc:
store.updateSession(sessionId, (s) => {
  if (s.appendedItems.some((item) => item.id === newItem.id)) return s;
  return { ...s, appendedItems: [...s.appendedItems, newItem] };
});
```

This is the **single most impactful fix** — it acts as a safety net regardless of the upstream cause.

### Fix 2: Ensure `pi_surfaced` always uses the same messageId as `message_end` (addresses #1)

In `src/runtime.ts:644-652`, when `finalMessageId` is undefined, instead of generating a new random UUID, look up the server UUID by scanning the blackboard for the most recent assistant message in this session:

```ts
// Fallback: find the server UUID of the most recent assistant message in this session
const resolvedMessageId = finalMessageId
  ? (resolveServerId(this.blackboard, finalMessageId) ?? finalMessageId)
  : lookupLatestAssistantServerUuid(this.blackboard, managed.piSessionId);
```

Or simpler: skip the `pi_surfaced` broadcast when the message ID can't be resolved, since the `message_end` already delivered the content.

### Fix 3: Ensure deterministic tool IDs even without `lastAssistantId` (addresses #2)

In `src/pi/subscribe.ts`, when `lastAssistantId` is undefined, use `streamingServerUuid` or a session-scoped counter as fallback:

```ts
const deterministicId = toolCallId
  ? `${lastAssistantId ?? streamingServerUuid ?? session.sessionId}:tool:${toolCallId}:start`
  : undefined;
```

### Fix 4: Clear `appendedItems` for a session when its history is refetched (addresses reconnect overlap)

After `router.invalidate()` triggers a history refetch, the route component should clear the store's accumulated items for that session, since the fresh history supersedes them. This can be done in the route component:

```ts
useEffect(() => {
  // When history changes (e.g., after reconnect refetch), clear WS accumulator
  // since mergeTimelines will handle the merge
  // Actually, mergeTimelines already handles this — but clearing prevents stale growth
}, [history]);
```

Or more precisely, clear the session accum in the reconnect handler before the loader refetches.

---

## What the Recent Fixes Got Right

- **State machine** (ws.ts) — prevents duplicate connections with guarded transitions
- **`closeSocket()` nulling all handlers** — prevents zombie callbacks from old sockets
- **HMR singleton** (`window.__autonoma_wsClient`) — prevents orphaned clients on hot reload
- **`connect()` guard** — no-op when already connecting/connected
- **Heartbeat + visibility** — detects stale connections proactively
- **`subscribeSession("*")` in root** — single wildcard subscription, properly cleaned up

The connection layer is solid. The duplicate issue is at the **message/event layer**, not the transport layer.
