# Spec: Client-Side Streaming Bypass

Bypass React state for text_delta events. Accumulate streaming text in a mutable ref and push directly to the DOM web component. Sync to React state only on stream completion.

## Functional Requirements

### FR1: Mutable streaming accumulator
Create a module-level streaming accumulator (outside React) that the WS handler writes to directly. This is NOT React state — it's a plain mutable object keyed by sessionId:
```ts
type StreamingState = { text: string; messageId: string };
const activeStreams = new Map<string, StreamingState>();
```
Exposed via piSessionStore as imperative methods: `appendStreamingDelta(sessionId, messageId, delta)` and `getStreamingState(sessionId)` and `clearStreamingState(sessionId)`. These do NOT call notify(). They mutate in place.

### FR2: Direct web component update from WS handler
In use-pi-ws-handler.ts, the text_delta case must:
1. Call `store.appendStreamingDelta(sessionId, messageId, delta)` — mutable, no React render
2. Call a registered callback (set by ChatPanel) that imperatively updates the PiStreamingMessage web component's `message` property
The callback pattern: piSessionStore exposes `onStreamingDelta(sessionId, callback)` / `offStreamingDelta(sessionId)`. ChatPanel registers a callback on mount that takes the accumulated text and pushes it to the web component ref.

### FR3: ChatPanel streaming ref
ChatPanel no longer receives streamingText as a prop. Instead:
1. It holds a ref to the PiStreamingMessage web component element
2. On mount, it registers a streaming delta callback via `piSessionStore.onStreamingDelta(sessionId, (text, messageId) => { ... })`
3. The callback builds an AssistantMessage and sets it on the web component ref: `elementRef.current.message = buildStreamingAssistantMessage(text)`
4. It also sets visibility: show the streaming component when first delta arrives, hide on stream end
5. Cleanup on unmount: `piSessionStore.offStreamingDelta(sessionId)`
This is NOT a useEffect watching streaming state. It's a callback registration that happens once on mount (or when sessionId changes). The callback itself is called synchronously from the WS handler — no React in the loop.

### FR4: Stream completion sync
On message_end (assistant) and turn_end, the WS handler:
1. Reads the final text from `store.getStreamingState(sessionId)`
2. Calls `store.clearStreamingState(sessionId)`
3. Calls `store.updateSession()` to add the completed message to appendedItems (this IS a React render — exactly one)
4. The streaming delta callback is called with null to hide the streaming component
This is already how message_end works, just without the streamingText state removal step.

### FR5: Remove streamingText from SessionAccum
Remove `streamingText` and `streamingMessageId` fields from the SessionAccum type. They are replaced by the mutable activeStreams map. This means:
- usePiSessionStore snapshot no longer changes on text_delta
- Components reading snapshot (PiMessageList, route components) don't re-render during streaming
- The only render trigger during streaming is the imperative callback, which updates a single DOM element

### FR6: Stabilize timeline reference in route components
In pi.default.tsx and pi.$sessionId.tsx, memoize the timeline computation properly:
```ts
const surfacedAccumItems = useMemo(() => filterSurfacedItems(accum.appendedItems), [accum.appendedItems]);
const timeline = useMemo(() => mergeTimelines(history, surfacedAccumItems), [history, surfacedAccumItems]);
```
Currently mergeTimelines creates a new array every render, defeating downstream useMemo.

### FR7: PiStreamingMessage simplification
PiStreamingMessage no longer receives message/visible as props. Instead it exposes an imperative API via ref (or a module-level function) that ChatPanel calls:
- `updateStreaming(message: AssistantMessage)` — sets el.message, shows element
- `clearStreaming()` — hides element
This eliminates the useEffect that currently watches the message prop.

## Constraints
- No new npm dependencies
- No useEffect for the streaming hot path — the delta callback is registered once, called imperatively
- The PiMessageList must NOT re-render during streaming (verify with React DevTools or console.log in render)
- Multi-session support: activeStreams is keyed by sessionId, callbacks are per-sessionId
