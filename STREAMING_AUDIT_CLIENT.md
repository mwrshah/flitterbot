# Client-Side WebSocket Streaming Audit

## 1. How are incoming WS messages dispatched to React state?

**Answer: One `store.updateSession()` call per WS message — no batching.**

The pipeline is:

1. `AutonomaWsClient.socket.onmessage` (`web/src/lib/ws.ts:95-104`) parses JSON then iterates `this.subscribers`, calling each synchronously.
2. The single subscriber is registered in `usePiWsHandler` (`web/src/hooks/use-pi-ws-handler.ts:43`). It pattern-matches on `message.type` and calls `store.updateSession()` for each relevant event.
3. Every `updateSession()` call (`web/src/lib/pi-session-store.ts:59-63`) creates a **new `Map`**, sets the updated session, and calls `notify()` which creates a **new snapshot object** and fires all `useSyncExternalStore` listeners.

```ts
// pi-session-store.ts:59-63
function updateSession(sessionId: string, updater: (s: SessionAccum) => SessionAccum) {
  const current = sessions.get(sessionId) ?? emptyAccum();
  sessions = new Map(sessions);          // ← new Map per update
  sessions.set(sessionId, updater(current));
  notify();                               // ← triggers React re-render
}
```

**During streaming, every `text_delta` event fires one `updateSession()` which fires one `notify()`.** There is no debouncing, `requestAnimationFrame` batching, or microtask coalescing. Each delta = one synchronous React re-render cycle.

React 18's automatic batching helps *within event handlers*, but `onmessage` fires as a browser event outside React's control. Each `onmessage` → `notify()` → `useSyncExternalStore` listener is a separate render trigger. If multiple WS messages arrive in the same microtask (unlikely with a single socket), React 18 would batch them — but in practice each message arrives in its own event loop tick.

## 2. Does each text delta trigger a full React re-render cycle?

**Yes. Each `text_delta` triggers a re-render of every component consuming `usePiSessionStore()`.**

The render chain per delta:

1. `notify()` creates new snapshot → `useSyncExternalStore` fires → route component re-renders
2. **Route** (`pi.default.tsx:42`): `usePiSessionStore()` returns new snapshot → re-renders
3. **Route body**: `piSessionStore.getSessionAccum()` is called inline (not memoized against snapshot) → always returns fresh `SessionAccum`
4. **ChatPanel** receives new `streamingText` prop → re-renders
5. **`useMemo(() => timelineToAgentMessages(timeline), [timeline])`** — `timeline` is `mergeTimelines(history, surfacedAccumItems)` which creates a new array each render, so this memo **always recomputes** even when only `streamingText` changed
6. **`useMemo(() => buildStreamingAssistantMessage(streamingText), [streamingText])`** — correctly memoized, recomputes only when text changes
7. **`PiStreamingMessage`** — sets `el.message = message` on a web component via DOM property assignment (`pi-streaming-message.tsx:53`). This bypasses React diffing (good) but still runs the React render function each time.
8. **`PiMessageList`** re-renders on every delta because `agentMessages` is recomputed (new ref). The message list itself hasn't changed during streaming — this is **wasted work**.

### Render cost estimate

Per `text_delta` (typically 1-20 chars, arriving every ~50-100ms during streaming):
- 1x `new Map()` + snapshot creation
- 1x route re-render
- 1x `mergeTimelines()` — O(n) where n = history length (dedup via Set)
- 1x `timelineToAgentMessages()` — O(n) timeline traversal with look-ahead (unnecessary during streaming)
- 1x `filterSurfacedItems()` — O(n) filter
- 1x `ChatPanel` re-render including header, input, message list
- 1x `PiMessageList` re-render (unnecessary — messages haven't changed)

For a conversation with 100 timeline items and a response streaming 500 deltas, that's ~500 unnecessary `timelineToAgentMessages()` calls and 500 unnecessary `PiMessageList` re-renders.

## 3. Is there a message queue or are messages processed synchronously on arrival?

**Synchronous. No queue, no buffering, no backpressure.**

The flow is entirely synchronous:

```
WebSocket.onmessage → JSON.parse → subscriber callback → store.updateSession → notify → React render
```

All in one call stack. There is no:
- Message queue or buffer
- `requestAnimationFrame` coalescing
- `setTimeout(0)` batching
- Async processing or yielding to the event loop between parse and render

The server broadcasts `text_delta` events one per Anthropic API streaming chunk (`src/pi/subscribe.ts:97-108`). Each SDK `text_delta` event generates one WS message which triggers one full render cycle.

**Implication**: If React rendering takes longer than the inter-delta interval (~50-100ms), deltas will queue up in the browser's event loop, causing visible jank. The browser cannot paint between processing queued deltas since each synchronously triggers a render.

## 4. What store pattern is used? Is it optimal for high-frequency updates?

**Custom external store using `useSyncExternalStore` — the right primitive, but suboptimal implementation for streaming.**

Architecture (`web/src/lib/pi-session-store.ts`):
- Module-level singleton (`piSessionStore`) — no React context overhead
- Manual listener set + snapshot pattern — compatible with `useSyncExternalStore`
- Snapshot is `{ sessions: Map<string, SessionAccum>, connectionState }`

### What's good
- `useSyncExternalStore` is the correct React 18 primitive for external stores — avoids tearing
- No React context (no provider re-renders propagating down the tree)
- Singleton means the store is always available regardless of component mount order

### What's suboptimal

**1. Coarse snapshot granularity.** Every `updateSession()` creates a new top-level snapshot. All consumers of `usePiSessionStore()` re-render on *any* session change, even if they only care about one session. The `InputSurface` component (`input-surface.tsx:357`) subscribes to the full snapshot just to get `getAllAppendedItems()`.

**2. No selector support.** Unlike Zustand's `useStore(selector)`, there's no way to subscribe to a slice. Every component gets the full snapshot and re-renders on any change.

**3. Immutable copies on every update.** `sessions = new Map(sessions)` on every delta. The `SessionAccum` updater also spreads: `{ ...s, streamingText: (s.streamingText ?? "") + message.delta }`. During streaming, this creates O(n^2) string concatenation (each delta appends to a growing string and copies it).

**4. `streamingText` and `appendedItems` in same object.** High-frequency streaming updates (`streamingText`) are interleaved with low-frequency structural updates (`appendedItems`). Any component reading `appendedItems` also re-renders on every `streamingText` change because they share the same `SessionAccum`.

### Comparison with Zustand

Zustand would offer:
- `useStore(s => s.sessions.get(id)?.streamingText)` — only re-render when streaming text changes
- Built-in shallow equality for selectors
- `temporal` middleware for undo/redo if needed
- Essentially the same external store pattern, but with selector infrastructure

## 5. Could TanStack AI's `stream()` ConnectionAdapter wrap our WebSocket?

**Yes, with moderate effort. The mapping is natural but requires server-side changes.**

### Adapter shape

TanStack AI's custom `ConnectionAdapter` expects:

```ts
stream(fn): where fn receives (messages, data?, signal?) → AsyncIterable<StreamChunk>
```

Where `StreamChunk` types map to AG-UI protocol events.

### Mapping our WS events to AG-UI StreamChunk types

| Our WS event | AG-UI StreamChunk type | Notes |
|---|---|---|
| `queue_item_start` | `RUN_STARTED` | Map `item.id` → `runId`, `item.source` → metadata |
| `text_delta` | `TEXT_MESSAGE_CONTENT` | `delta` → `delta`, need to add `messageId` mapping |
| `message_end` (assistant) | `TEXT_MESSAGE_CONTENT` (final) + `RUN_FINISHED` | Or emit as `TEXT_MESSAGE_END` |
| `message_end` (user) | No direct equivalent | User messages come from local state in TanStack AI |
| `tool_execution_start` | `TOOL_CALL_START` + `TOOL_CALL_ARGS` | `toolUseId` → `toolCallId`, `args` → serialized |
| `tool_execution_end` | `TOOL_RESULT` | `result` → `result`, `isError` → `isError` |
| `turn_end` | `RUN_FINISHED` | Map to run completion |
| `queue_item_end` | `RUN_FINISHED` (with error if present) | |

### What the adapter would look like

```ts
function autonomaStreamAdapter(wsClient: AutonomaWsClient): ConnectionAdapter {
  return {
    stream(fn) {
      return async function* (messages, data, signal) {
        // Subscribe to WS and yield StreamChunks
        const queue = new AsyncQueue<StreamChunk>();

        const unsub = wsClient.subscribe((msg) => {
          switch (msg.type) {
            case "text_delta":
              queue.push({ type: "TEXT_MESSAGE_CONTENT", delta: msg.delta, messageId: msg.messageId });
              break;
            case "queue_item_start":
              queue.push({ type: "RUN_STARTED", runId: msg.item.id });
              break;
            case "turn_end":
              queue.push({ type: "RUN_FINISHED" });
              queue.done();
              break;
            // ... other mappings
          }
        });

        signal?.addEventListener("abort", () => { unsub(); queue.done(); });

        yield* queue;
      };
    }
  };
}
```

### What we'd get from TanStack AI's `useChat()`

- **Incremental message state** — `messages` array with the last message's `content` growing incrementally, no manual `streamingText` accumulation
- **`isLoading`** — derived from run state, replaces manual pill tracking
- **`stop()`** — abort signal propagation, currently missing from our implementation
- **Error handling** — structured error state instead of ad-hoc error pills
- **Message history** — managed by the hook, potentially replacing `mergeTimelines`

### Friction points

1. **Multi-session**: TanStack AI's `useChat()` assumes one conversation. We have multi-session with `sessionId` routing. We'd need one `useChat()` per session or a custom multiplexing layer.
2. **User messages from external sources**: WhatsApp/Hook/Cron messages arrive via WS as `message_end` with `role: "user"`. TanStack AI assumes user messages originate locally. We'd need to inject these into the message list.
3. **Tool events as timeline items**: Our UI shows tool calls inline in the chat. TanStack AI's `useChat()` handles tool calls but may not expose them as renderable items the way we need.
4. **Lit web components**: Our `PiMessageList` and `PiStreamingMessage` use web components expecting `AgentMessage[]`. The bridge layer (`pi-web-ui-bridge.ts`) would still be needed to convert from TanStack AI's message format.
5. **Status pills**: Queue processing indicators are UI-specific and wouldn't map to TanStack AI abstractions.

### Verdict

Adoption is feasible for the **streaming text** use case — replacing manual `streamingText` accumulation with `useChat()` would eliminate the biggest performance issue. But the multi-session, multi-source, tool-timeline requirements mean we can't simply drop in `useChat()` as a full replacement. A hybrid approach — using the `ConnectionAdapter` for streaming text while keeping our store for session routing and tool events — is the most practical path.

## 6. What would need to change server-side for AG-UI StreamChunk protocol?

The server (`src/pi/subscribe.ts`) currently broadcasts custom event types. AG-UI protocol requires specific `StreamChunk` shapes.

### Required changes

**1. Event type field**: AG-UI uses numeric or string enum types (`TEXT_MESSAGE_CONTENT`, `RUN_STARTED`, etc.) instead of our string `type` field. The server would need to either:
- Change the broadcast format (breaking change for existing clients)
- Add an AG-UI endpoint/mode alongside the existing format
- Let the client adapter handle the mapping (no server changes)

**2. Run lifecycle events**: AG-UI expects explicit `RUN_STARTED` / `RUN_FINISHED` events with a `runId`. Our `queue_item_start`/`queue_item_end` map naturally but would need the field names adjusted:
```ts
// Current
{ type: "queue_item_start", item: { id, source }, sessionId }
// AG-UI
{ type: "RUN_STARTED", runId: item.id, threadId: sessionId }
```

**3. Message content format**: AG-UI `TEXT_MESSAGE_CONTENT` expects:
```ts
{ type: "TEXT_MESSAGE_CONTENT", messageId: string, delta: string }
```
Our `text_delta` already has `messageId` and `delta` — this is a direct match. Only the `type` field name differs.

**4. Tool call format**: AG-UI splits tool calls into `TOOL_CALL_START` (name + id), `TOOL_CALL_ARGS` (streamed args), and `TOOL_RESULT`. Our current `tool_execution_start` bundles name + id + args in one event. Would need to either split or have the adapter synthesize the intermediate events.

**5. Thread/session ID**: AG-UI uses `threadId` where we use `sessionId`. Trivial rename.

### Recommendation: Client-side adapter, not server changes

The mapping is mechanical and 1:1. Changing the server protocol has blast radius (WhatsApp integration, other consumers of the WS hub). A client-side adapter that translates our current WS events to AG-UI `StreamChunk` types is lower risk and achieves the same goal. The server only needs changes if we want to support third-party AG-UI clients connecting directly.

---

## Recommendations

### Priority 1: Reduce render cost during streaming (high impact, low effort)

**Split `streamingText` out of `SessionAccum` into a separate subscription channel.**

Currently every `text_delta` triggers a full snapshot rebuild and re-renders all consumers. Instead:
- Store `streamingText` in a separate `Map<sessionId, string>` with its own `notify` + `useSyncExternalStore` hook
- Components that only need the message list (`PiMessageList`) won't re-render during streaming
- The `ChatPanel` can split: `PiStreamingMessage` subscribes to streaming text, `PiMessageList` subscribes to timeline items

**Estimated impact**: Eliminates ~90% of unnecessary re-renders during streaming. `timelineToAgentMessages()` and `PiMessageList` would only re-render on actual message/tool events, not on every text chunk.

### Priority 2: Fix `timeline` reference stability (medium impact, low effort)

In `pi.default.tsx:74`, `mergeTimelines(history, surfacedAccumItems)` creates a new array every render, defeating `useMemo` in `ChatPanel`. Memoize it:

```ts
const timeline = useMemo(
  () => mergeTimelines(history, surfacedAccumItems),
  [history, surfacedAccumItems]
);
```

But `surfacedAccumItems` also needs stabilization — `filterSurfacedItems(accum.appendedItems)` creates a new array each render. Use `useMemo` with `accum.appendedItems` as dep.

### Priority 3: Coalesce rapid deltas with `requestAnimationFrame` (medium impact, low effort)

Wrap `notify()` in a `requestAnimationFrame` guard so multiple deltas arriving within one frame only trigger one render:

```ts
let rafPending = false;
function notify() {
  snapshot = { sessions: new Map(sessions), connectionState };
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      for (const fn of listeners) fn();
    });
  }
}
```

This would batch multiple rapid deltas into a single React render per animation frame (~16ms).

### Priority 4: Evaluate TanStack AI adoption (medium impact, high effort)

Build a proof-of-concept `ConnectionAdapter` wrapping `AutonomaWsClient` for a single-session view. Measure whether `useChat()` provides meaningful UX improvements (stop button, error recovery, optimistic updates) beyond what we can achieve with Priorities 1-3.

The multi-session and external-source requirements make full adoption complex. Start with the default session view (`pi.default.tsx`) as the pilot.

### Priority 5: String concatenation optimization (low impact, low effort)

Replace `streamingText: (s.streamingText ?? "") + message.delta` with an array of chunks joined only at render time:

```ts
// Store chunks, not concatenated string
streamingChunks: [...(s.streamingChunks ?? []), message.delta]

// Join at render time (memoized)
const streamingText = useMemo(() => chunks?.join("") ?? null, [chunks]);
```

This avoids O(n^2) string copying during long responses. For a 10KB response arriving in 500 chunks, the current approach copies ~25MB total; chunk array approach copies ~10KB.
