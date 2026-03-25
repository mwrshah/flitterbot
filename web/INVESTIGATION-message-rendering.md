# Investigation: Assistant Message Rendering Lifecycle

## Current Flow (step by step)

### Page Load with Existing Conversation

1. **Route loader** (`pi.$sessionId.tsx:10-19`) fetches full history via `fetchPiHistory()`. Blocking — nothing renders until history arrives.
2. **Root layout** mounts, calls `usePiWsHandler()` which resets the global `piSessionStore` and subscribes to all WS events.
3. **Session route** mounts, calls `usePiSessionStore()` hook, merges historical timeline with any live-accumulated items.
4. **ChatPanel** mounts (`chat-panel.tsx:66`):
   - Converts timeline to `AgentMessage[]` via `timelineToAgentMessages()` (line 87)
   - Registers streaming callback on the store (line 94-110)
   - Renders `<PiMessageList>` and `<PiStreamingMessage>` (lines 150-155)
5. **PiMessageList** (`pi-message-list.tsx`):
   - Waits for `ensurePiWebUiReady()` (async Lit component registration)
   - Creates `<message-list>` element, sets `.messages`, `.isStreaming`, etc. (lines 51-63)
   - Lit renders historical messages — each assistant message becomes an `<assistant-message>` element with `.message` already set via the template
6. **PiStreamingMessage** (`pi-streaming-message.tsx`):
   - Also waits for `ensurePiWebUiReady()`
   - Creates an **empty** `<assistant-message>` element with `display: none` (line 48-51)
   - **No `.message` property is set at creation time**
   - Exposes imperative `update(message)` / `clear()` via `useImperativeHandle`

### Streaming Flow (WS delta arrives)

1. WS `text_delta` → `use-pi-ws-handler.ts:88-89` → `store.appendStreamingDelta()`
2. Store accumulates text and **synchronously** calls registered callback (`pi-session-store.ts:136-140`)
3. ChatPanel callback fires (`chat-panel.tsx:97-104`):
   - Builds message: `buildStreamingAssistantMessage(text)` (returns `{role, content: [{type: "text", text}], ...}`)
   - Calls `streamingRef.current?.update(msg)` — sets `.message` and `.isStreaming` directly on Lit element
4. Lit reactivity triggers `AssistantMessage.render()`

### Stream End

1. WS `message_end` → `store.clearStreamingState()` → callback with `(null, null)`
2. ChatPanel calls `streamingRef.current?.clear()` → hides element
3. Store also calls `updateSession()` to add completed message to timeline
4. React re-renders → PiMessageList updates `<message-list>` → historical list now includes the completed message

---

## Problems Identified

### P1: `<assistant-message>` created without `.message` — causes crash (FIXED)

**Location:** `pi-streaming-message.tsx:48-51`

The streaming wrapper creates the Lit element via `document.createElement("assistant-message")` without setting the `.message` property. Lit's lifecycle (`connectedCallback` → first `render()`) fires immediately on `appendChild`. The `render()` method at `chat-components.ts:847` does `for (const chunk of this.message.content)` — crashes with `TypeError: Cannot read properties of undefined (reading 'content')`.

**Why this happens:** The element is pre-created so that the imperative `update()` API can push data synchronously from the WS callback without React in the loop. The assumption was that `display: none` prevents rendering, but Lit renders regardless of CSS visibility.

**Status:** Fixed with `nothing` guard. But the architectural question remains: should the element be created lazily?

### P2: Streaming element created even when no stream is active

**Location:** `pi-streaming-message.tsx:46-53`, `chat-panel.tsx:155`

`<PiStreamingMessage>` is **always** mounted in ChatPanel's render tree and always creates a DOM element on mount — even for historical conversations with no active stream. This is:
- Wasteful: creates a hidden Lit element that may never be used
- The root cause of P1: element exists before any data could possibly be available

**Recommendation:** Defer element creation to the first `update()` call instead of doing it in the mount effect. The imperative ref API already handles the `!el` case with an early return (`pi-streaming-message.tsx:58`).

### P3: Stale closure over `isStreaming` in streaming callback

**Location:** `chat-panel.tsx:104`

```typescript
if (!isStreaming) setIsStreaming(true);
```

The callback registered in the `useEffect` (line 94-110) closes over `isStreaming` from the render where the effect ran. The dependency array is `[sessionId]` only (line 110), so `isStreaming` is stale after the first `setIsStreaming(true)`. This means `setIsStreaming(true)` is called on **every** delta, not just the first one. Each call triggers a React state update and reconciliation — though React batches and deduplicates `true → true`, it's still unnecessary work.

**Recommendation:** Use a ref to track streaming state for the callback, or use a functional updater: `setIsStreaming(prev => prev || true)` — though `setIsStreaming(true)` is already idempotent in React. Low priority since React deduplicates identical state.

### P4: Potential flicker on stream→historical transition

**Location:** `chat-panel.tsx:98-100` (clear) vs `use-pi-ws-handler.ts:120-141` (add to timeline)

When a stream ends:
1. `clearStreamingState()` fires the callback with `null` → streaming element hidden
2. `updateSession()` adds the completed message to the timeline → triggers React re-render → PiMessageList updates

Steps 1 and 2 happen synchronously in the same WS handler callback (`use-pi-ws-handler.ts:120-141`), but step 1's effect (hiding the streaming element) is immediate DOM manipulation, while step 2 goes through React's async rendering pipeline. There's a gap where the streaming message is hidden but the historical message hasn't appeared yet.

**Recommendation:** Reverse the order — add to timeline first, then clear streaming state. Or keep the streaming element visible until the historical list confirms it has rendered the message (e.g., via a `requestAnimationFrame` or Lit's `updateComplete` promise).

### P5: Full property reassignment on every timeline change

**Location:** `pi-message-list.tsx:59-63`

Every time `messages`, `isStreaming`, or `pendingToolCalls` changes, ALL properties are reassigned to the Lit element:
```typescript
el.messages = messages;
el.tools = [];
el.pendingToolCalls = pendingToolCalls ?? new Set<string>();
el.isStreaming = isStreaming;
```

`el.tools = []` creates a new empty array every time, which Lit sees as a new value (referential inequality), triggering a re-render even if nothing changed. Same for `new Set<string>()`.

**Recommendation:** Hoist the empty array and empty set to module-level constants:
```typescript
const EMPTY_TOOLS: AgentTool[] = [];
const EMPTY_PENDING = new Set<string>();
```

### P6: `MessageList.buildRenderItems()` uses index-based keys

**Location:** `chat-components.ts:950, 958`

Keys are `msg:${index}` where `index` is a sequential counter. When a new message is prepended or inserted mid-list, all keys shift, causing Lit's `repeat()` directive to destroy and recreate DOM nodes unnecessarily. Historical messages have stable IDs that should be used instead.

**Recommendation:** Use the message's `id` or a composite key from message properties instead of positional index.

---

## Recommendations (prioritized)

| Priority | Issue | Fix | Impact |
|----------|-------|-----|--------|
| **Done** | P1: crash on undefined message | Guard with `nothing` in render | Eliminates crash |
| **High** | P2: eager element creation | Create `<assistant-message>` in `update()`, not mount | Eliminates P1 root cause; reduces idle DOM |
| **Medium** | P4: stream→historical flicker | Reverse clear/add order in WS handler, or keep streaming visible until historical renders | Smoother UX |
| **Medium** | P6: index-based keys | Use message IDs as keys in `repeat()` | Fewer DOM thrashes on list updates |
| **Low** | P5: referential inequality on empty values | Hoist constants | Minor perf improvement |
| **Low** | P3: stale closure | Already harmless due to React dedup | Code clarity |

### Detailed Fix for P2 (recommended next step)

In `pi-streaming-message.tsx`, remove the eager creation effect and move element creation into `update()`:

```
// Remove the useEffect at lines 46-53 that creates the element on mount

// In useImperativeHandle's update():
update(message) {
  if (!containerRef.current) return;
  let el = elementRef.current;
  if (!el) {
    el = document.createElement("assistant-message");
    containerRef.current.appendChild(el);
    elementRef.current = el;
  }
  (el as any).message = message;
  (el as any).isStreaming = true;
  (el as any).hideToolCalls = false;
  el.style.display = "block";
}
```

This makes the guard in P1 a defense-in-depth measure rather than the primary fix.
