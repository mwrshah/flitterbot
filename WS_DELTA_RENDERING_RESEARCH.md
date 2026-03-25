# WebSocket Delta Rendering in React: Research Findings

## Problem Statement

Server pushes AI text deltas (streaming LLM output) over WebSocket at high frequency — each delta is a small text chunk. Naive React patterns (`setState` per message, string concatenation in state) cause re-render storms that freeze the UI and introduce visible latency. We need sub-frame text updates without overloading the main thread.

---

## Patterns (Ranked by Effectiveness)

### 1. Hybrid DOM + State Sync (Best for Streaming LLM Text)

**How it works:** During active streaming, append tokens directly to a DOM element via `ref.current.textContent += delta`, bypassing React entirely. When the stream completes, sync the final text to React state for downstream reactivity.

```tsx
const outputRef = useRef<HTMLDivElement>(null);

// During stream — zero React renders
ws.onmessage = (event) => {
  const delta = JSON.parse(event.data);
  if (outputRef.current) {
    outputRef.current.textContent += delta.text;
  }
};

// On stream end — single state sync
const finalText = outputRef.current?.textContent || '';
setMessageContent(finalText);
```

**Why it wins:**
- Zero re-renders during streaming (tokens render in <1ms each)
- Single reconciliation at stream end
- Used by production AI chat apps (ChatGPT, Claude web)
- No library dependencies

**Tradeoffs:**
- Must handle markdown rendering separately (can't use React markdown components during stream — either render raw text then parse at end, or use a streaming markdown parser)
- Manual scroll management (`scrollIntoView` or `scrollTop` manipulation)
- ARIA live regions need imperative updates for accessibility

**When to use:** Active message being streamed. Switch to React-managed rendering for completed messages.

### 2. Mutable Store + requestAnimationFrame Batching

**How it works:** Accumulate deltas in a mutable ref or external store. Use `requestAnimationFrame` to batch-notify React, capping updates at ~60/sec regardless of message frequency.

```tsx
const textRef = useRef('');
const rafId = useRef<number>();
const [displayText, setDisplayText] = useState('');

ws.onmessage = (event) => {
  textRef.current += JSON.parse(event.data).text; // Mutable accumulation

  if (!rafId.current) {
    rafId.current = requestAnimationFrame(() => {
      setDisplayText(textRef.current); // Single setState per frame
      rafId.current = undefined;
    });
  }
};
```

**Why it's good:**
- Stays within React's model (state drives rendering)
- Natural 60fps cap from rAF
- Works well with React.memo children
- Compatible with markdown rendering on each frame

**Tradeoffs:**
- Still one React render per frame (~60/sec) — acceptable but not zero
- ~16ms latency between delta arrival and display (imperceptible)

### 3. useSyncExternalStore + External Mutable Store

**How it works:** Create an external mutable store that React subscribes to via `useSyncExternalStore`. The store accumulates deltas and notifies subscribers on a rAF schedule.

```tsx
// External store
let text = '';
let listeners = new Set<() => void>();

const streamStore = {
  getSnapshot: () => text,
  subscribe: (cb: () => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  append: (delta: string) => {
    text += delta;
    // Batch notifications via rAF
    requestAnimationFrame(() => listeners.forEach(l => l()));
  },
};

// Component
function StreamingMessage() {
  const content = useSyncExternalStore(streamStore.subscribe, streamStore.getSnapshot);
  return <div>{content}</div>;
}
```

**Why it's good:**
- React-idiomatic (concurrent mode safe, no tearing)
- Selective subscriptions — only components reading the snapshot re-render
- Clean separation of concerns
- Works with SSR (`getServerSnapshot`)

**Tradeoffs:**
- More boilerplate than Pattern 1 or 2
- Still triggers React reconciliation (though targeted)

### 4. Zustand/Valtio with Batched Updates

**How it works:** Use an external state manager with built-in subscription optimization. Queue messages externally, flush in batches.

```tsx
// Zustand example
const messageQueue: string[] = [];

const useChatStore = create((set, get) => ({
  streamingContent: '',
  flushQueue: () => {
    if (messageQueue.length === 0) return;
    const batch = messageQueue.splice(0);
    set({ streamingContent: get().streamingContent + batch.join('') });
  },
}));

// WS handler — no setState
ws.onmessage = (event) => {
  messageQueue.push(JSON.parse(event.data).text);
  requestAnimationFrame(() => useChatStore.getState().flushQueue());
};
```

**Useful if:** You're already using Zustand/Valtio for chat state. Valtio's proxy model is particularly good here — mutations don't trigger re-renders until the proxy snapshot is read.

### 5. Throttled Hook (Time-Based Batching)

**How it works:** Custom hook collects deltas for a configurable interval (50-200ms), then flushes as a single state update.

Good for simpler cases but inferior to rAF batching because:
- Fixed interval means either unnecessary latency (200ms) or wasted renders (50ms with no new data)
- rAF naturally aligns with browser paint cycles

---

## Anti-Patterns

### 1. `setState` Per WebSocket Message
```tsx
// DO NOT DO THIS
ws.onmessage = (event) => {
  setMessages(prev => [...prev, event.data]); // Re-render storm
};
```
At 20+ messages/sec, this creates cascading re-renders. React batches within event handlers but NOT across async callbacks (WebSocket `onmessage` is async). Each `setState` triggers a full reconciliation cycle.

### 2. String Concatenation in React State Per Delta
```tsx
// DO NOT DO THIS
ws.onmessage = (event) => {
  setContent(prev => prev + event.data); // New string object every delta
};
```
Creates a new string on every delta. Combined with re-renders, this compounds: React diffs the entire message content on every chunk. For a 2000-token response at 50 tokens/sec, that's 40 renders with increasingly large string diffs.

### 3. Re-rendering the Entire Message List
```tsx
// DO NOT DO THIS
ws.onmessage = (event) => {
  setMessages(prev => prev.map(m =>
    m.id === activeId ? { ...m, content: m.content + event.data } : m
  ));
};
```
Recreates the entire messages array on every delta. Even with `React.memo` on individual message components, the parent list re-renders and React must shallow-compare every message object.

### 4. Unbounded Array Growth
Never let message arrays grow without limits in long sessions. Prune old messages or use virtualization for history.

### 5. `useEffect` Chains for WebSocket
```tsx
// Fragile pattern
useEffect(() => {
  ws.onmessage = handler;
}, [handler]); // Re-subscribes on every handler change
```
If `handler` isn't properly memoized, this re-subscribes on every render, potentially dropping messages during re-subscription.

---

## Production Examples

### ChatGPT / Claude Web
- **Direct DOM manipulation** during active streaming (`textContent += token`)
- React state sync only on stream completion
- Virtual scrolling for message history
- CSS-only typing indicators and animations
- Auto-scroll via imperative `scrollTop`/`scrollIntoView`

### Vercel AI SDK (`useChat`)
- `experimental_streamText` streams tokens via SSE
- Internally batches state updates
- Provides `isLoading`/`isStreaming` flags
- Handles structured output and tool calls in-stream

### General Patterns Observed
- **Separation of active vs. completed messages**: Active streaming message uses imperative rendering; completed messages use React components (with markdown, code highlighting, etc.)
- **Two-phase rendering**: Raw text during stream → rich rendering after completion
- **Virtual scrolling**: `react-window` or `@tanstack/virtual` for chat history (keeps DOM at ~20-30 nodes regardless of history length)

---

## Lightweight Libraries

| Library | Purpose | Notes |
|---------|---------|-------|
| `react-streaming-text` | Progressive text rendering (word-by-word) | Headless, no styling assumptions |
| `@tanstack/react-virtual` | Virtual scrolling for long lists | Essential for chat history |
| `react-window` | Simpler virtual scrolling alternative | Fixed/variable size lists |
| `@stream-io/chat-react-ai` | Full AI chat UI kit | Heavier, opinionated |

For our case, no library is needed for the core rendering — the hybrid DOM pattern is ~20 lines of code. Use `@tanstack/react-virtual` if message history performance becomes an issue.

---

## Recommended Approach for Autonoma

Given our architecture (WebSocket → React chat UI, streaming LLM output):

### During Active Stream
1. **Use the Hybrid DOM pattern (Pattern 1)**: Append deltas directly to `ref.current.textContent` — zero React renders during streaming
2. **Auto-scroll imperatively**: `ref.current.scrollIntoView({ behavior: 'smooth' })` or direct `scrollTop` manipulation
3. **Show a cursor/caret**: CSS `::after` pseudo-element with blinking animation on the streaming container

### On Stream Complete
1. **Sync final text to React state**: `setMessageContent(ref.current.textContent)`
2. **Render completed message with React**: Now apply markdown parsing, code highlighting, copy buttons, etc.
3. **Add to message history**: Update the messages array once (single re-render for the list)

### For Message History
1. **React.memo on each message component**: Completed messages are immutable, memo prevents re-renders
2. **Virtual scrolling if needed**: Only if history exceeds ~100 messages and scrolling becomes janky
3. **Zustand for global chat state**: Messages array, conversation metadata — already in our stack

### Architecture Summary
```
WebSocket delta → append to DOM ref (zero renders)
                → auto-scroll imperatively
                → on complete: sync to React state
                → render rich message via React
                → add to Zustand messages array
```

This gives us:
- **Zero re-renders** during streaming (direct DOM)
- **Sub-millisecond** token-to-pixel latency
- **Single reconciliation** at stream end
- **Full React ergonomics** for completed messages
- **No additional dependencies** for the core pattern

---

## Sources

- Perplexity sonar-pro research: "best patterns for rendering high frequency websocket streaming text deltas in React without re-render storms 2025"
- Perplexity sonar-pro research: "how does ChatGPT Claude web app render streaming LLM token output React performance optimization direct DOM manipulation vs React state"
- Perplexity sonar-pro research: "useSyncExternalStore mutable ref requestAnimationFrame React streaming text bypass rerender 2024 2025"
- Perplexity sonar-pro research: "zustand valtio external store high frequency updates React websocket chat streaming text anti-patterns setState every message"
- Perplexity sonar-pro research: "React streaming text LLM output direct DOM innerText ref then sync state after stream complete pattern hybrid approach 2024 2025"
- Perplexity sonar search: "react streaming text LLM chat render library lightweight 2024"
