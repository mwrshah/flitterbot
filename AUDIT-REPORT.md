# WebSocket Streaming Performance Audit

Audit date: 2026-04-01
Scope: Server-side WS emission pipeline, client-side state management, React rendering

---

## 1. Server-Side Emission Issues

### 1.1 Per-token broadcast with no batching/throttling

**File:** `src/streams/pi-subscribe.ts:252-262`
**Severity:** CRITICAL

Every `text_delta` and `thinking_delta` from the LLM triggers an immediate `broadcast()` call. At typical LLM token rates (~30-60 tokens/sec), this means 30-60 WebSocket frames per second, each individually JSON-serialized and written to every subscribed socket.

```ts
// Current: fires on every single token
if (ame.type === "text_delta" && typeof ame.delta === "string") {
  broadcast(wsHub, { type: "text_delta", ... delta: ame.delta });
}
```

**Proposed fix:** Buffer deltas server-side and flush at ~15-20Hz (every 50-66ms). This cuts WS frame count by 2-4x while maintaining smooth visual streaming.

```ts
// Sketch: accumulate deltas, flush on timer
const deltaBuffer = new Map<string, string>(); // sessionId -> accumulated text
const FLUSH_INTERVAL = 50; // ms

function flushDeltas(wsHub, sessionId, messageId) {
  const buffered = deltaBuffer.get(sessionId);
  if (buffered) {
    broadcast(wsHub, { type: "text_delta", piSessionId: sessionId, messageId, delta: buffered });
    deltaBuffer.delete(sessionId);
  }
}
```

### 1.2 JSON.stringify + encodeFrame on every broadcast, per client

**File:** `src/ws/hub.ts:86-107`
**Severity:** LOW (already optimized)

The hub correctly pre-serializes the frame once (`encodeFrame(JSON.stringify(payload))` on line 90) and writes the same buffer to all matching clients. This is the right approach. No issue here.

### 1.3 tool_execution_update forwarded without throttling

**File:** `src/streams/pi-subscribe.ts:390-403`
**Severity:** MEDIUM

`tool_execution_update` events (partial tool results) are forwarded immediately. The `hasPartialContent()` filter (line 109-117) prevents empty shells but doesn't throttle bursts. If a tool streams output rapidly, this creates the same per-event overhead as text deltas.

**Proposed fix:** Apply the same batching/throttling as text deltas, or debounce with a 100ms trailing timer per toolUseId.

### 1.4 `event` object leaked in tool execution payloads

**File:** `src/streams/pi-subscribe.ts:365-373, 377-387, 394-402`
**Severity:** LOW

The `ToolExecutionStartWebSocketEvent`, `ToolExecutionEndWebSocketEvent`, and `ToolExecutionUpdateWebSocketEvent` payloads include the raw `event` object. This duplicates data already extracted into named fields (`tool`, `toolUseId`, `args`, `result`) and bloats WS frame size.

**Proposed fix:** Remove `event` from these payloads. The extracted fields are sufficient. Reduces frame size and serialization cost.

---

## 2. Client-Side State Management Issues

### 2.1 Immutable array copies on every timeline mutation

**File:** `ws-query-bridge.ts:87-171` (appendTimelineItem), `ws-query-bridge.ts:176-210` (upsertTimelineItem), `ws-query-bridge.ts:214-228` (updateTimelineItem)
**Severity:** HIGH

Every `setQueryData` call creates a new array via spread: `[...items, item]` or `const updated = [...old]; updated[idx] = item;`. During a single agent turn with N tool calls, this produces O(N) full array copies.

This is actually acceptable because these mutations happen at message boundaries (message_end, tool_execution_start/end) — not per-token. The real hot path (text_delta) correctly bypasses Query cache entirely (see 2.2). Still, for sessions with many tool calls in rapid succession, the cumulative cost of array copies + TanStack Query notifications adds up.

**Proposed fix:** Consider batching timeline mutations within a single `setQueryData` call when processing a burst of tool events. Alternatively, a more structural fix: use a Map-based store (keyed by item ID) instead of an array, with a derived sorted view.

### 2.2 Streaming store is well-designed (mutable, no React)

**File:** `web/src/lib/streaming-store.ts`
**Severity:** N/A (positive finding)

The streaming store is already using mutable `Map` entries with string concatenation (`existing.text += delta`) and imperative callbacks to the Lit web component. This is the correct architecture — text deltas bypass React entirely. No issue here.

### 2.3 fireCallbacks fires on every single delta

**File:** `web/src/lib/streaming-store.ts:39-57, 69-78`
**Severity:** MEDIUM

`appendTextDelta()` calls `fireCallbacks()` on every delta, which invokes the Lit component's `updateStreaming()`. At 30-60Hz from the server, this means 30-60 imperative DOM updates per second.

The Lit component likely handles this fine (Lit batches property updates within a microtask), but if the component's `updateStreaming` triggers layout/paint synchronously, this becomes the bottleneck.

**Proposed fix:** Add a `requestAnimationFrame` coalescing guard in `fireCallbacks`:

```ts
let rafPending = new Set<string>();

function scheduleCallback(sessionId: string) {
  if (rafPending.has(sessionId)) return;
  rafPending.add(sessionId);
  requestAnimationFrame(() => {
    rafPending.delete(sessionId);
    fireCallbacks(sessionId);
  });
}
```

This coalesces multiple deltas arriving within the same frame (~16ms) into a single Lit update, cutting render work by up to 60-70% during fast streaming.

### 2.4 console.log in hot path

**File:** `web/src/lib/streaming-store.ts:49-55`, `ws-query-bridge.ts:163-168`
**Severity:** LOW

Debug `console.log` calls in `fireCallbacks` (when messageId is null) and in `appendTimelineItem` fire during normal operation. While not in the per-delta hot path, they add noise and minor overhead during message boundaries.

**Proposed fix:** Gate behind `import.meta.env.DEV` or remove entirely.

---

## 3. React Rendering Issues

### 3.1 MutationObserver + ResizeObserver on subtree with observeDOM: true

**File:** `web/src/hooks/use-stick-to-bottom.ts:63-103`, `web/src/components/chat-panel.tsx:77`
**Severity:** HIGH

ChatPanel uses `useStickToBottom({ observeDOM: true })` which installs:
- A `MutationObserver` on the scroll container with `{ childList: true, subtree: true }` (line 91)
- A `ResizeObserver` on every child element (line 74), plus dynamically on added nodes (line 81)

The comment in the hook itself warns: *"No MutationObserver / ResizeObserver (those create feedback loops with virtual lists)"* — yet the non-virtual mode is being used here with a Lit web component that imperatively mutates DOM on every streaming update.

The chain: streaming delta → Lit updates DOM → MutationObserver fires → `el.scrollTop = el.scrollHeight` → possible layout reflow → ResizeObserver fires → another `scrollTop` assignment.

This creates a potential feedback loop during streaming:
1. Lit component updates its shadow DOM
2. MutationObserver fires (subtree: true catches shadow DOM mutations if the observer is on the host)
3. `scrollTop` assignment forces synchronous layout
4. ResizeObserver fires from layout change
5. Another `scrollTop` assignment

**Proposed fix:** Two options:
- **Option A (targeted):** Throttle the auto-scroll to rAF cadence. The observer callbacks should set a dirty flag, and a single rAF loop does the actual `scrollTop` update.
- **Option B (structural):** Since the Lit component is imperatively managed, have the streaming callback in ChatPanel call `scrollToBottom()` directly after `updateStreaming()`, and disable `observeDOM`. This is more predictable and eliminates the observer overhead entirely.

```ts
// Option B sketch in ChatPanel:
const { viewportRef, scrollToBottom, engageAndScroll, isAtBottomRef } = useStickToBottom();
// In streaming callback:
messageListRef.current?.updateStreaming(msg, isThinking);
if (isAtBottomRef.current) scrollToBottom();
```

### 3.2 timelineToAgentMessages recomputes on every array reference change

**File:** `web/src/hooks/use-agent-messages.ts:7-9`, `web/src/lib/pi-web-ui-bridge.ts:55-158`
**Severity:** MEDIUM

`useAgentMessages` depends on `[timeline]` — the entire timeline array reference. Every `setQueryData` call in the bridge creates a new array reference (see 2.1), which invalidates this memo and re-runs `timelineToAgentMessages`.

The function iterates the full timeline and creates new `AgentMessage` objects every time. For a session with 100+ timeline items, this is non-trivial work on every tool event.

**Proposed fix:** The `StreamsMessageList` already has a custom `memo` comparator checking `prev.messages === next.messages` (line 114). The problem is upstream: `useAgentMessages` always returns a new array reference when timeline changes. Consider:
1. Fingerprint the output (hash of message IDs + count) and return the previous reference if unchanged
2. Or incrementally append — maintain the previous AgentMessage[] and only convert new timeline items

### 3.3 StreamsMessageList re-renders only on reference change (good)

**File:** `web/src/components/streams-message-list.tsx:112-114`
**Severity:** N/A (positive finding)

The custom memo comparator `(prev, next) => prev.messages === next.messages` prevents re-renders when the messages array is referentially stable. Streaming deltas go through `updateStreaming()` imperatively, bypassing React. This is correct.

### 3.4 ChatPanel re-renders on statusPills array changes

**File:** `web/src/components/chat-panel.tsx:34-51`
**Severity:** LOW

`statusPills` is a Query cache array that changes on every `addPill`/`removePill` call. During streaming, pills change at message boundaries (typing indicator add/remove). Each pill change triggers a full ChatPanel re-render including the header, button states, and MessageInput.

The `StreamsMessageList` is protected by memo, but everything else in ChatPanel re-renders. The `MessageInput` component receives stable callbacks (useCallback) but `skills`, `pendingImages`, and `isSending` create re-render opportunities.

**Proposed fix:** Extract the header/pills section into a separate memoized component. This prevents pill changes from re-rendering the message input area.

### 3.5 No key optimization for ChatPanel's status pills

**File:** `web/src/components/chat-panel.tsx:177-181`
**Severity:** LOW

The pills are keyed by `pill.id` which is correct. No issue here.

---

## 4. WS Fan-Out / Subscription Scoping

### 4.1 Hub subscription filtering is well-implemented

**File:** `src/ws/hub.ts:86-107`, `web/src/lib/ws-route-subscriptions.ts`
**Severity:** N/A (positive finding)

The hub correctly:
- Scopes events by piSessionId (line 98-104)
- Supports event type filtering (line 103)
- Route-based subscriptions narrow the filter further (e.g., surface view only subscribes to `stream_surfaced`)

No unnecessary fan-out issue.

---

## 5. Prioritized Action Plan

### Critical (do first — biggest impact on perceived performance)

1. **Server-side delta batching** (Issue 1.1)
   - Buffer `text_delta` and `thinking_delta` events, flush every 50ms
   - Reduces WS frame rate from ~30-60/sec to ~15-20/sec
   - Single biggest improvement: halves network I/O, JSON serialization, and downstream processing
   - Estimated effort: ~2 hours

### High (significant improvement)

2. **Fix auto-scroll observer feedback loop** (Issue 3.1)
   - Switch ChatPanel to `observeDOM: false` and drive scroll from streaming callback
   - Eliminates MutationObserver/ResizeObserver overhead during streaming
   - Prevents layout thrashing from scroll → observe → scroll cycle
   - Estimated effort: ~1 hour

3. **Coalesce streaming store callbacks to rAF** (Issue 2.3)
   - Add `requestAnimationFrame` guard in `fireCallbacks`
   - Ensures Lit component updates at most once per display frame
   - Estimated effort: ~30 minutes

### Medium (measurable improvement)

4. **Throttle tool_execution_update** (Issue 1.3)
   - Debounce partial tool results per toolUseId
   - Estimated effort: ~1 hour

5. **Optimize timelineToAgentMessages** (Issue 3.2)
   - Fingerprint-based memoization to avoid returning new references when content hasn't changed
   - Estimated effort: ~1 hour

### Low (cleanup / minor)

6. **Remove raw `event` from tool WS payloads** (Issue 1.4)
   - Reduces frame size
   - Estimated effort: ~15 minutes

7. **Gate debug console.log behind DEV** (Issue 2.4)
   - Estimated effort: ~15 minutes

8. **Extract header pills to memoized component** (Issue 3.4)
   - Prevents unnecessary ChatPanel re-renders from pill changes
   - Estimated effort: ~30 minutes

---

## Architecture Assessment

The overall architecture is **well-designed for streaming performance**:

- The streaming store correctly uses mutable state + imperative callbacks, bypassing React for per-token updates
- The Lit web component handles rendering outside React's reconciliation cycle
- TanStack Query is only used for message-boundary events (message_end, tool events)
- WS hub pre-serializes frames and has proper subscription filtering

The main bottlenecks are:
1. **Server-side**: No delta batching — each token becomes its own WS frame
2. **Auto-scroll**: MutationObserver with `subtree: true` creates a feedback loop with the Lit component's DOM mutations
3. **Callback frequency**: `fireCallbacks` fires per-delta instead of per-frame

Fixing items 1-3 from the action plan should eliminate the perceived sluggishness. The remaining items are diminishing-returns optimizations.
