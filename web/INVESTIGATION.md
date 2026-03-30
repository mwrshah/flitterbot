# WS Message Chain Investigation

## 1. Current Architecture (Data Flow)

```
WebSocket (browser native)
  │
  ▼
AutonomaWsClient (ws.ts)
  │  - Manages connection lifecycle, heartbeat, reconnect, visibility
  │  - Parses JSON, fans out to subscriber callbacks
  │
  ├──▶ setupWsQueryBridge (ws-query-bridge.ts)  ← single subscriber
  │      │
  │      ├── Status events (connected, workstreams_changed, status_changed, sessions_changed, worktree_changed)
  │      │     └──▶ queryClient.invalidateQueries() → React re-render via useQuery
  │      │
  │      ├── Queue events (queue_item_start/end)
  │      │     └──▶ queryClient.setQueryData(["pi-status-pills", sid]) → React re-render
  │      │
  │      ├── Streaming deltas (text_delta, thinking_*, toolcall_start)
  │      │     └──▶ streamingStore (streaming-store.ts)  ← imperative Map-based store
  │      │           └──▶ fireCallbacks() → ChatPanel's useEffect callback
  │      │                 └──▶ messageListRef.current.updateStreaming() → Lit component (no React render)
  │      │
  │      ├── Committed messages (message_end, agent_end)
  │      │     └──▶ queryClient.setQueryData(["pi-history", sid, "agent"]) → React re-render
  │      │         + streamingStore.clearSession() → Lit component clearStreaming()
  │      │
  │      ├── Tool events (tool_execution_start/update/end)
  │      │     └──▶ queryClient.setQueryData(["pi-history", sid, "agent"]) → React re-render
  │      │
  │      └── pi_surfaced
  │            └──▶ queryClient.setQueryData(["pi-input-surface-timeline"]) → React re-render
  │
  ├──▶ wsClient.subscribeConnection() (inside setupWsQueryBridge)
  │      └──▶ queryClient.setQueryData(["connection-state"]) → React re-render
  │           + invalidateQueries on reconnect
  │
  └──▶ setupWsRouteSubscriptions (ws-route-subscriptions.ts)
         │  - Listens to router.subscribe("onResolved") + queryCache "status" changes
         └──▶ wsClient.setSessionSubscription() / clearSessionSubscription()
              (tells server which session events to send)
```

### Component consumption chain:

```
pi.default.tsx (route)
  └── usePiChat(sessionId, loaderHistory)
        ├── useQuery(["pi-history", sid, "agent"])  → timeline
        ├── useQuery(["pi-status-pills", sid])      → statusPills
        └── useQuery(["connection-state"])           → connectionState
  └── <ChatPanel>
        ├── receives timeline, statusPills, connectionState as props
        ├── useAgentMessages(timeline)  → transforms to AgentMessage[]
        ├── useEffect: streamingStore.onStreamingDelta(sid, cb) → pushes to Lit component
        └── <PiMessageList ref={messageListRef} messages={agentMessages} />
              └── Lit <message-list> web component (imperative property assignment)
```


## 2. Identified Issues

### Issue #1: streaming-store.ts is a parallel state system to TanStack Query
**Files:** `src/lib/streaming-store.ts:1-164`, `src/lib/ws-query-bridge.ts:291-369`

The streaming store exists because "routing deltas through TanStack Query would trigger cache notifications on every chunk — too expensive" (streaming-store.ts:7-8). This is a **valid performance concern** — at ~30Hz, `setQueryData` would cause excessive React re-renders. The store uses imperative callbacks to push directly to the Lit web component, bypassing React entirely.

**Verdict:** The streaming store is justified. It's not redundant — it serves a fundamentally different performance profile than Query cache. The Lit component integration requires imperative updates, and streaming deltas are ephemeral (cleared on message_end/agent_end).

### Issue #2: ChatPanel useEffect for streaming callback wiring
**File:** `src/components/chat-panel.tsx:90-124`

```ts
useEffect(() => {
  streamingStore.onStreamingDelta(sessionId, (text, thinking, ...) => {
    messageListRef.current?.updateStreaming(...);
  });
  return () => streamingStore.offStreamingDelta(sessionId);
}, [sessionId]);
```

This is imperative plumbing that connects the streaming store to the Lit component. It's a useEffect that acts as a subscription — conceptually similar to `useSyncExternalStore`, but it doesn't trigger React re-renders (it pushes to the Lit component via ref). Per project rules, this kind of imperative wiring is an anti-pattern if a TanStack primitive exists to replace it.

**However:** There's no TanStack primitive for "push data imperatively to a non-React component without triggering React renders." This useEffect bridges React ↔ Lit, which is inherently imperative. The anti-pattern rule targets cases where you should use `useQuery`/`useMutation` instead of `addEventListener` — this isn't that case.

**Verdict:** Acceptable given the Lit integration. Could potentially be encapsulated as a custom hook for clarity, but not a real issue.

### Issue #3: No `window.addEventListener('message')` or custom events found
**Files:** Grep across `src/` found zero `window.addEventListener('message')`, `CustomEvent`, `postMessage`, or `window.dispatchEvent`.

The only `document.addEventListener` calls are:
- `ws.ts:259` — `visibilitychange` for reconnect-on-tab-focus (standard browser API, appropriate)
- `use-theme.ts:50` — `matchMedia` change listener (standard)
- `use-stick-to-bottom.ts:39` — scroll listener (standard)

**Verdict:** Clean. No anti-pattern window event dispatching.

### Issue #4: Duplicate `useIsClient` definition
**Files:** `src/hooks/use-pi-chat.ts:13-19`, `src/components/chat-panel.tsx:14-20`

The same `useIsClient` hook is defined inline in two files. Minor code duplication, not a data flow issue.

### Issue #5: Data copying chain for committed messages
**Files:** `ws-query-bridge.ts:291-369`, `streaming-store.ts:61-150`

When a message completes, this happens:
1. During streaming: WS deltas → `streamingStore.texts` Map + `streamingStore.thinking` Map
2. On `message_end`: bridge reads `streamingStore.getThinkingText()` → builds committed message → `queryClient.setQueryData(["pi-history"])` → then `streamingStore.clearSession()`
3. On `agent_end`: bridge reads `streamingStore.getUncommittedText()` → upserts to Query cache → then `streamingStore.clearSession()`

Data flows: **WS → streamingStore → Query cache**. The streaming store acts as a buffer for in-flight content that gets "committed" to the Query cache when the message is complete. This is a deliberate two-phase pattern, not accidental duplication.

**Verdict:** Intentional design. The streaming store is ephemeral (high-frequency), the Query cache is the committed state (low-frequency). The "copy" on message_end is a commit operation.

### Issue #6: `message_end` + `agent_end` both flush streaming state
**File:** `ws-query-bridge.ts:328-503`

Both `message_end` (line 328) and `agent_end` (line 486) call `streamingStore.clearSession()`. The `agent_end` handler additionally has an "uncommitted text" flush (line 490-499) as a safety net for text that arrived via `text_delta` but never got a `message_end`.

This is **defensive redundancy**, not a bug. The `clearSession` call is idempotent (streaming-store.ts:132-139 checks `hadState`). However, it means two event types do overlapping work.

**Verdict:** Acceptable defensive coding. Could document the invariant more clearly (agent_end is the safety net for dropped message_end events).

### Issue #7: Tool call two-phase commit pattern
**File:** `ws-query-bridge.ts:317-451`

Tool calls go through:
1. `toolcall_start` → `streamingStore.addPendingToolCall()` (buffered)
2. `message_end` → `streamingStore.flushPendingToolCalls()` → `appendTimelineItem()` (committed to Query cache as stub)
3. `tool_execution_start` → tries to upgrade the stub in Query cache with args, falls back to fresh append
4. `tool_execution_update` → updates in-place via `updateTimelineItem()`
5. `tool_execution_end` → appends end item

This is a 4-hop chain for a single tool call lifecycle. The buffering in step 1-2 exists because `toolcall_start` fires *during* the assistant's message, before `message_end` commits the message. The tool stub needs to appear in the timeline *after* the message, so it's buffered.

**Verdict:** Complex but motivated by ordering requirements. The "upgrade" fallback in step 3 handles reconnect scenarios. Could potentially be simplified if the server guaranteed event ordering.

### Issue #8: `piHistoryQueryOptions` merge logic
**File:** `src/lib/queries.ts:16-47`

The `queryFn` in `piHistoryQueryOptions` reads *existing* Query cache data inside the query function itself to merge with fetched data:
```ts
const existing = queryClient?.getQueryData<ChatTimelineItem[]>(key);
// ...merge fetched + extras
```

This is unusual — query functions typically don't read cache. It exists to prevent "oscillation" during reconnect (comment on line 33). When a reconnect triggers `invalidateQueries`, the refetch from the server might return stale data that doesn't include items accumulated via WS `setQueryData`. The merge preserves those WS-accumulated items.

**Verdict:** Necessary but fragile. This is a consequence of the dual-write pattern (server fetch + WS setQueryData both populate the same cache key). A cleaner approach might use TanStack Query's `structuralSharing` or a custom `select` to avoid cache-reading-inside-queryFn.

### Issue #9: `turn_end` handler only clears streaming store
**File:** `ws-query-bridge.ts:479-483`

```ts
if (message.type === "turn_end") {
  streamingStore.clearSession(sessionId);
  return;
}
```

`turn_end`, `message_end`, and `agent_end` all call `streamingStore.clearSession()`. Three event types doing the same cleanup suggests the protocol has redundant end-of-turn signals, or the bridge is being maximally defensive.


## 3. Simplification Strategies

### Strategy #1: Extract shared `useIsClient` hook
**What:** Move the duplicated `useIsClient` from `chat-panel.tsx` and `use-pi-chat.ts` into a shared `hooks/use-is-client.ts`.
**Why:** DRY — identical code in two files.
**Impact:** Low. Pure cleanup, no behavior change.

### Strategy #2: Evaluate collapsing `turn_end` into `agent_end` handling
**What:** If `turn_end` always precedes `agent_end` in the server protocol, the `turn_end` handler's `clearSession` call is redundant (agent_end does the same). Verify with server code whether `turn_end` can arrive without a subsequent `agent_end`.
**Why:** Three event types doing the same cleanup is confusing.
**Impact:** Low-medium. Simplifies the bridge's mental model. Requires server protocol verification.

### Strategy #3: Refactor `piHistoryQueryOptions` merge to avoid cache-in-queryFn
**What:** Instead of reading cache inside `queryFn`, use a wrapper that does the merge at the call site, or leverage `structuralSharing` / a reconciliation function. Alternatively, since `staleTime: Infinity` means the queryFn only runs on explicit `invalidateQueries` (reconnect), consider whether the merge is even needed — if the server returns authoritative data on reconnect, WS-accumulated items that aren't in the server response may be phantom items from the previous connection.
**Why:** Reading cache inside queryFn is a code smell that makes the data flow harder to reason about.
**Impact:** Medium. Affects reconnect behavior. Needs careful testing.

### Strategy #4: Consider whether the streaming store callback pattern could be a hook
**What:** The `streamingStore.onStreamingDelta` / `offStreamingDelta` pattern in `chat-panel.tsx:90-124` could be a `useStreamingDelta(sessionId, messageListRef)` hook.
**Why:** Encapsulates the imperative Lit bridge wiring, makes ChatPanel cleaner.
**Impact:** Low. Pure encapsulation, no behavior change.

### Strategy #5: Evaluate if `toolcall_start` buffering could be removed
**What:** If the server could guarantee that `tool_execution_start` always arrives (even without a preceding `toolcall_start`), the buffering in streamingStore (`addPendingToolCall` / `flushPendingToolCalls`) and the flush-on-message-end logic could be removed. Tool items would only enter the Query cache via `tool_execution_start`.
**Why:** Eliminates a buffering hop and the "upgrade" fallback pattern.
**Impact:** Medium-high. Simplifies the tool call lifecycle from 4 hops to 2. Requires server protocol changes or guarantees.

### Strategy #6: Consolidate the three end-of-stream handlers
**What:** Extract a shared `commitStreamingState(queryClient, sessionId)` function that both `message_end` and `agent_end` call, instead of having inline logic in each handler. `turn_end` would call `streamingStore.clearSession()` only (as it does now, but explicitly documented as "cleanup-only, no commit").
**Why:** The commit logic (read thinking, upsert message, flush tools, clear session) is split across two handlers with subtle differences that are hard to track.
**Impact:** Medium. Improves readability and reduces risk of the two handlers diverging.


## 4. Recommended Priority Order

1. **Strategy #1** — Extract `useIsClient` (trivial, no risk)
2. **Strategy #4** — Extract `useStreamingDelta` hook (low risk, improves ChatPanel)
3. **Strategy #6** — Consolidate end-of-stream handlers (medium impact, no protocol changes needed)
4. **Strategy #2** — Evaluate `turn_end` redundancy (needs server protocol verification)
5. **Strategy #3** — Refactor queryFn merge (needs careful reconnect testing)
6. **Strategy #5** — Remove `toolcall_start` buffering (needs server protocol changes)

---

## Summary

The architecture is **cleaner than initially suspected**. There are no `window.addEventListener('message')` anti-patterns, no custom event dispatching, and no Zustand — the streaming store is a plain Map-based imperative store with callbacks. The dual-store pattern (streaming store for high-frequency ephemeral deltas, TanStack Query cache for committed state) is a **deliberate performance optimization** for the Lit web component integration, not accidental complexity.

The main simplification opportunities are:
- Code organization (extract shared hooks, consolidate end-of-stream logic)
- Protocol-level simplifications (remove redundant event handling if server guarantees can be established)
- The `queryFn`-reads-cache pattern in `piHistoryQueryOptions` is the most architecturally questionable piece
