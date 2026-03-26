# Chat Panel Streaming Message Order

## Problem

During an agent turn, the user should see a single chronological stream: text flows in, a tool call appears inline, the tool result follows, more text streams. Instead, the chat panel renders two spatially fixed layers — completed messages bunched at the top, streaming content always pinned at the bottom — so the visual order never matches the chronological order of WS events.

## Current Architecture

### Data Flow

```
WebSocket
  │
  v
use-pi-ws-handler.ts             Routes each WS event by type
  │
  ├─ text_delta ──────────────┐
  ├─ thinking_delta ──────────┤
  ├─ toolcall_start ──────────┤   Streaming path (imperative, no React)
  ├─ toolcall_delta ──────────┤   Stored in per-session Maps in piSessionStore
  │                           │   Callbacks fire → ChatPanel pushes to PiStreamingMessage ref
  │                           │
  ├─ message_end ─────────────┤   Completed path (React state)
  ├─ tool_execution_start ────┤   Appended to appendedItems[] in piSessionStore
  ├─ tool_execution_end ──────┤   Triggers useSyncExternalStore → React re-render
  ├─ tool_execution_update ───┤
  └─ turn_end ────────────────┘

Route component (pi.default.tsx / pi.$sessionId.tsx)
  │  mergeTimelines(loaderHistory, accum.appendedItems) → timeline[]
  v
ChatPanel (chat-panel.tsx)
  │
  │  agentMessages = timelineToAgentMessages(timeline)   ← completed items
  │  pendingToolCalls = pendingToolCallsFromTimeline(timeline)
  │
  │  DOM layout (fixed spatial order):
  │  ┌──────────────────────────────────────────────┐
  │  │  <PiMessageList>                              │  ← ALL completed messages
  │  │    <message-list>                             │     rendered as a block
  │  │      user msg, assistant msg, tool calls...   │
  │  │    </message-list>                            │
  │  ├──────────────────────────────────────────────┤
  │  │  <PiStreamingMessage>                         │  ← ALWAYS below message list
  │  │    <assistant-message>                        │     single element, imperatively
  │  │      streaming text + thinking + tool calls   │     updated via ref
  │  │    </assistant-message>                       │
  │  └──────────────────────────────────────────────┘
```

### The Two-Layer Rendering Model

**Layer 1 — PiMessageList** (completed content):
- Wraps a `<message-list>` Lit web component
- Receives `AgentMessage[]` (converted from timeline by `timelineToAgentMessages`)
- Also receives `pendingToolCalls: Set<string>` and `isStreaming: boolean`
- The Lit `<message-list>` builds `resultByCallId` map and passes `.hidePendingToolCalls=${this.isStreaming}` to each `<assistant-message>` — **when streaming is active, pending tool calls in the completed list are hidden**
- Tool results (`role: "toolResult"`) are never rendered as standalone items — they're collected into `resultByCallId` and looked up by the `<assistant-message>` that owns the tool call

**Layer 2 — PiStreamingMessage** (in-progress content):
- Wraps a single `<assistant-message>` Lit element
- Updated imperatively via ref — **bypasses React entirely**
- ChatPanel holds three mutable variables (`currentChunkedText`, `currentThinking`, `currentToolCalls`) that accumulate streaming state
- On every delta, `buildStreamingAssistantMessage()` combines all three into one `AssistantMessage` object and pushes it to the Lit element
- On `message_end` (null callback), the element is hidden via `display: none`

### How `timelineToAgentMessages` Reshapes the Timeline

This bridge converts flat `ChatTimelineItem[]` into the `AgentMessage[]` shape the Lit components expect:

1. **User messages** → `{ role: "user", ... }`
2. **Assistant messages** → `{ role: "assistant", content: [...text, ...thinking, ...toolCalls] }` — look-ahead consumes immediately following `tool_execution_start` items, attaching them as `ToolCall` content blocks
3. **Orphan tool starts** (no preceding assistant message) → wrapped in a synthetic `{ role: "assistant", content: [toolCall] }`
4. **Tool ends** → `{ role: "toolResult", ... }` — but `<message-list>` **skips these during rendering** and instead collects them into `resultByCallId`, passed to the `<assistant-message>` that owns the call

### How `pendingToolCalls` and `hidePendingToolCalls` Interact

- `pendingToolCallsFromTimeline()` scans the timeline for tool starts without matching ends → `Set<string>`
- `<message-list>` passes `.hidePendingToolCalls=${this.isStreaming}` to each `<assistant-message>`
- Inside `<assistant-message>`, for each `toolCall` content block: if `hidePendingToolCalls && pending && !result` → **skip rendering**
- This means: while streaming is active, tool calls that haven't finished yet are hidden from the completed list, presumably because they're expected to show in the streaming layer instead

## Root Cause Analysis

### The core problem: two spatially fixed rendering zones

The DOM structure is:
```jsx
<div className="flex-1 overflow-auto px-6 py-4 space-y-3">
  <PiMessageList ... />      {/* always renders first, at the top */}
  <PiStreamingMessage ... />  {/* always renders second, at the bottom */}
</div>
```

This creates a fundamental ordering constraint: **all completed content is above all streaming content, always**. There is no way for a completed tool result to appear between two streaming text segments, or for streaming text to appear above a completed tool call.

### Walkthrough: what the user actually sees during a multi-tool turn

Consider the real WS event sequence for an agent turn with tool use:

```
1. text_delta "Let me check..."     → streaming layer shows text
2. text_delta "...the database"     → streaming layer accumulates
3. toolcall_start (index=0, sql)    → streaming layer shows text + tool call
4. toolcall_delta (partial JSON)    → streaming layer updates tool args
5. message_end (assistant)          → completed list gets assistant msg
                                       streaming layer CLEARS (text gone, tool gone)
6. tool_execution_start             → completed list gets tool-start item
                                       (but hidePendingToolCalls=true while streaming,
                                        so the tool call is hidden from <assistant-message>!)
7. tool_execution_end               → completed list gets tool-end item
                                       (toolResult collected into resultByCallId,
                                        now the assistant-message can show the tool call
                                        because result exists → no longer hidden)
8. text_delta "The results show..." → streaming layer shows new text
9. message_end (final)              → completed list gets second assistant msg
                                       streaming layer CLEARS
10. turn_end                        → divider
```

**What the user sees at each step:**

| Step | Completed List (top) | Streaming (bottom) | Visual Problem |
|------|---------------------|---------------------|----------------|
| 1-2 | (empty or prior msgs) | "Let me check...the database" | OK |
| 3-4 | (same) | text + sql tool call | OK |
| 5 | assistant msg appears | **CLEARS** — text and tool call vanish | **Flash**: streaming content disappears before completed msg renders (React async vs imperative sync) |
| 6 | assistant msg (tool call hidden because pending+streaming) | (empty) | **Gap**: tool is in completed list but hidden; not in streaming either |
| 7 | assistant msg + tool call + result (now visible) | (empty) | Tool call + result pop in all at once |
| 8 | assistant msg + tool (above) | "The results show..." (below) | **Split**: tool result is above, new streaming text is below — but chronologically the text follows the tool result. Correct order but wrong visual grouping. |
| 9 | two assistant msgs + tool | **CLEARS** | Second flash |

### Specific problems identified

**Problem 1: Spatial separation prevents chronological interleaving.** The user should see: text → tool call → tool result → more text, as one continuous downward flow. Instead they see: completed block (text+tool+result) pinned at top, then streaming text pinned below. When the streaming text completes it jumps up into the completed block, changing its position.

**Problem 2: Content disappears on `message_end`.** At step 5, `clearStreamingState` fires `cb(null, null)` which causes `streamingRef.current?.clear()` (sets `display: none`). The completed message is added to `appendedItems` in the same synchronous block, but React must re-render to show it. During this gap, the content vanishes.

**Problem 3: `hidePendingToolCalls` creates a visibility hole.** Between steps 6-7, the tool call exists in the completed assistant message's content (via `timelineToAgentMessages` look-ahead), but `<assistant-message>` hides it because `hidePendingToolCalls=true` (streaming is active) and the tool is pending with no result. The tool is invisible in both layers.

**Problem 4: Single streaming element can't represent multi-message sequences.** `PiStreamingMessage` renders one `<assistant-message>`. During a turn, the agent may produce multiple assistant messages interleaved with tool calls. The streaming layer can only show the *current* one — it can't show the accumulated sequence of completed messages + the current streaming message as a unified chronological stream.

**Problem 5: `buildStreamingAssistantMessage` flattens everything into one message.** Text, thinking, and tool calls are all merged into a single `AssistantMessage.content` array. This works for one streaming segment but can't represent the multi-step structure of: text → tool call → tool result → text.

## Proposed Solution Architecture

### Goal

Render all content — completed and streaming — in a single chronological list where items appear in the exact order WS events arrive, with streaming content flowing naturally at the bottom of the sequence (where it chronologically belongs).

### Approach: Unified timeline with streaming tail

Replace the two-layer model with a single `<message-list>` that contains both completed messages and the current streaming message as the last item.

**Key design decisions:**

1. **One rendering component, not two.** Remove `PiStreamingMessage` as a separate component. Instead, append a "streaming" assistant message as the last item in the `AgentMessage[]` array passed to `<message-list>`.

2. **Streaming content accumulates in position.** As WS events arrive during a turn, the streaming assistant message sits at the end of the list — below completed messages, tool calls, and tool results from earlier in the same turn. This is the correct chronological position.

3. **No hide/show toggle for pending tool calls.** Remove `hidePendingToolCalls`. Tool calls in completed assistant messages should always be visible. The streaming layer no longer duplicates them.

4. **Flush = replace last item.** When `message_end` fires, the streaming assistant message is replaced in-place by the completed version. No spatial jump, no flash. Subsequent tool execution events append below it.

5. **Imperative updates still bypass React.** The performance optimization of pushing streaming deltas directly to the Lit component is preserved — but now the target element is the last `<assistant-message>` in the `<message-list>`, not a separate component.

### Data flow after change

```
WebSocket events
  │
  v
use-pi-ws-handler.ts → piSessionStore
  │
  │  appendedItems[] holds completed messages + tool events (as before)
  │  streaming state holds current partial text/thinking/toolcalls (as before)
  │
  v
ChatPanel
  │
  │  1. timeline = mergeTimelines(history, appendedItems)
  │  2. agentMessages = timelineToAgentMessages(timeline)
  │  3. if streaming: append streaming assistant message to agentMessages
  │  4. pass unified list to <message-list>
  │
  v
PiMessageList (only component — no PiStreamingMessage)
  │
  │  <message-list> renders all items including streaming tail
  │  Last <assistant-message> has .isStreaming=true
  │  Imperative ref targets that last element for delta pushes
```

### Handling the streaming → completed transition

The critical moment is `message_end`. The new flow:

1. `message_end` appends completed assistant message to `appendedItems`
2. Streaming state clears → streaming tail disappears from the unified list
3. But the completed message now occupies the same position (end of list)
4. React re-renders `<message-list>` — the Lit component's `repeat()` directive sees the streaming key replaced by the completed key, so it swaps in place

To prevent the flash (React async), the streaming element should remain visible until React commits the update. Options:
- Keep the streaming element visible and let the Lit `repeat()` handle replacement when the new messages array arrives
- Use `requestAnimationFrame` or `queueMicrotask` to delay `clear()` until after React's commit

### What changes in the Lit components

The `<message-list>` component already handles all the rendering logic. The main changes:

- Remove `hidePendingToolCalls` — no longer needed since streaming doesn't duplicate tool calls
- The last item in `messages` may have `isStreaming=true` — `<message-list>` already passes this through
- Need a way for ChatPanel to imperatively update the last `<assistant-message>` in the list without triggering a full React re-render of the message array

### Imperative update strategy

The performance-critical path is streaming text deltas (60+ updates/sec via StreamChunker). Two options:

**Option A: Ref to last element.** After `<message-list>` renders, ChatPanel queries for the last `<assistant-message>` element and pushes updates directly. Simple but fragile — depends on DOM structure.

**Option B: Callback prop on `<message-list>`.** The Lit component exposes an `onStreamingUpdate` callback. ChatPanel calls it with the new `AssistantMessage`; the Lit component forwards to the last `<assistant-message>` element. Cleaner encapsulation.

**Option C: Dedicated streaming slot.** `<message-list>` accepts an optional `streamingMessage` property. When set, it appends a streaming `<assistant-message>` after all other items. Updates to this property bypass the `repeat()` directive — only the streaming element re-renders. This preserves the performance characteristics of the current approach while unifying the visual layout.

**Recommended: Option C.** It's closest to the current architecture (minimal Lit changes), avoids DOM queries, and maintains the imperative update path.

## Risks and Trade-offs

| Risk | Severity | Mitigation |
|---|---|---|
| Lit `<message-list>` re-renders on every streaming update | High | Option C avoids this — streaming message is outside `repeat()`, updated as a single property |
| Flash during streaming→completed transition | Medium | Keep streaming element visible until React commits; Lit swap handles the visual replacement |
| `timelineToAgentMessages` look-ahead produces wrong grouping | Low | Already handles orphan tool starts; unified ordering makes look-ahead more reliable |
| Breaking `<assistant-message>` component contract | Low | Component already supports `isStreaming` prop; no interface change needed |
| Increased complexity in `<message-list>` | Medium | Contained to one component; cleaner than the current two-component split with hidden state coordination |

## Files That Would Need to Change

| File | Change |
|---|---|
| `web/src/components/chat-panel.tsx` | Remove `PiStreamingMessage`; build unified message array; imperative updates target `<message-list>` streaming slot |
| `web/src/components/pi-streaming-message.tsx` | **Delete** — functionality absorbed into `<message-list>` |
| `web/src/components/pi-message-list.tsx` | Accept streaming message prop; expose ref for imperative streaming updates |
| `web/src/pi-web-ui/chat-components.ts` | `MessageList`: add `streamingMessage` property, render it after `repeat()` items. `AssistantMessage`: remove `hidePendingToolCalls` |
| `web/src/lib/pi-web-ui-bridge.ts` | Remove `pendingToolCallsFromTimeline` (no longer needed); `buildStreamingAssistantMessage` unchanged |
| `web/src/lib/pi-session-store.ts` | No changes — streaming state management stays the same |
| `web/src/hooks/use-pi-ws-handler.ts` | No changes — event routing stays the same |
