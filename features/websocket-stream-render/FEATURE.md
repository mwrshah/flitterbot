# WebSocket Stream Render Architecture

Architecture reference documenting how the web client handles real-time SSE/WebSocket events from agent sessions and renders them in the chat panel.

## The Dual-Path Rendering Model

All inbound WebSocket events split into two rendering paths based on their frequency and permanence:

```
                         WebSocket events
                              |
                     ws-query-bridge.ts
                       (event router)
                        /            \
              HIGH FREQUENCY         LOW FREQUENCY
              (ephemeral)            (persistent)
                   |                      |
          streaming-store         TanStack Query cache
          (mutable Maps)          (immutable snapshots)
                   |                      |
          imperative push         React re-render
          via callback            via useSyncExternalStore
                   |                      |
          Lit component           React props -> Lit
          .updateStreaming()      .messages property
                   |                      |
                   \                     /
                    \                   /
                  <message-list> Lit component
                  (single unified list)
```

**Streaming path** (left): `text_delta`, `thinking_delta`, `toolcall_start` events arrive at ~30Hz. They are accumulated in the streaming store's mutable Maps and pushed imperatively to the Lit `<message-list>` component via a registered callback. Zero React re-renders occur during this phase.

**Committed path** (right): `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end` events mutate the TanStack Query cache. This triggers React re-render via the query subscription, which flows new `messages` props down to the Lit component.

### Performance Invariants

- Zero React re-renders during active text/thinking streaming
- Sub-millisecond delta-to-pixel latency via imperative DOM updates
- Single React reconciliation when a message commits (`message_end`)
- Lit `repeat()` directive uses stable keys (`role:timestamp`) to minimize DOM churn on committed message updates

## The Streaming Store

**File**: `lib/streaming-store.ts`

A plain JavaScript module (not a React store) holding ephemeral per-session streaming state in five `Map<string, T>` instances:

| Map | Key | Value | Purpose |
|-----|-----|-------|---------|
| `texts` | sessionId | `{ text, messageId }` | Accumulated text from `text_delta` events |
| `thinking` | sessionId | `{ text, messageId }` | Accumulated thinking from `thinking_delta` events |
| `pendingTools` | sessionId | `PendingToolCall[]` | Tool calls seen via `toolcall_start`, held until `message_end` |
| `thinkingActive` | sessionId | `boolean` | True between `thinking_start` and `thinking_end` |
| `streamingCallbacks` | sessionId | `StreamingCallback` | Per-session callback registered by ChatPanel |

### Callback Mechanism

ChatPanel registers a `StreamingCallback` via `streamingStore.onStreamingDelta(sessionId, cb)`. Every mutation (append, clear) calls `fireCallbacks(sessionId)` which invokes the registered callback with the current snapshot:

```
cb(text | null, thinking | null, isThinkingStreaming, messageId | null, pendingToolCalls | null)
```

When `messageId` is `null` and there's no content, this is the **clear signal** — ChatPanel calls `messageListRef.clearStreaming()`.

### Why Not React State?

At ~30Hz delta rate, routing through React state (even `useSyncExternalStore`) would trigger: new Map creation -> snapshot rebuild -> subscriber notification -> O(n) timeline recomputation -> virtual DOM diff -> commit. The streaming store eliminates all of this by pushing directly to the Lit component's DOM properties.

## The WS-Query-Bridge

**File**: `lib/ws-query-bridge.ts`

A plain function (`setupWsQueryBridge`) called once at app startup. It subscribes to the WebSocket client and routes each event type to either the streaming store or the TanStack Query cache.

### Event Routing Table

| Event | Destination | Action |
|-------|------------|--------|
| `text_delta` | streaming store | `appendTextDelta()` — accumulates text, fires callback |
| `thinking_start` | streaming store | `setThinkingStreaming(true)` — pre-initializes thinking entry |
| `thinking_delta` | streaming store | `appendThinkingDelta()` — accumulates thinking text |
| `thinking_end` | streaming store | `setThinkingStreaming(false)` |
| `toolcall_start` | streaming store | `addPendingToolCall()` — buffers tool call until message_end |
| `message_start` | query cache | Adds "Thinking..." status pill |
| `message_end` | **both** | Commits message to query cache, flushes pending tools as tool-start items, then `clearSession()` on streaming store |
| `tool_execution_start` | query cache | Upgrades stub tool item (from message_end flush) with args, or appends fresh |
| `tool_execution_update` | query cache | Updates existing tool item phase from "start" to "update" with partial result |
| `tool_execution_end` | query cache | Appends tool-end item with result |
| `turn_end` | streaming store | `clearSession()` — safety net clear |
| `agent_end` | **both** | Flushes any uncommitted text to query cache, then `clearSession()` |

### The message_end Transition

This is the critical handoff from streaming to committed state:

1. Build committed `ChatTimelineMessage` with both thinking blocks and text blocks
2. `upsertTimelineItem()` — replaces intermediate message or appends new one
3. `flushPendingToolCalls()` — returns and clears all buffered tool calls
4. For each flushed tool call, `appendTimelineItem()` adds a `ChatTimelineTool` with `phase: "start"` (stub — no args yet)
5. `clearSession()` — wipes all streaming state, fires callback with nulls (clear signal)

The stubs committed in step 4 are later upgraded by `tool_execution_start` which fills in `args` and `tool` name.

### Query Cache Keys

| Key | Content |
|-----|---------|
| `["pi-history", sessionId, "agent"]` | `ChatTimelineItem[]` — the persistent ordered timeline |
| `["pi-status-pills", sessionId]` | `StatusPill[]` — transient UI indicators |
| `["pi-input-surface-timeline"]` | `ChatTimelineItem[]` — pi_surfaced messages |
| `["connection-state"]` | `ConnectionState` — WebSocket connection status |

### Dedup and Upsert

- `appendTimelineItem()`: Checks for duplicate tool items by `toolUseId + phase`, and duplicate messages by `id`. Skips if already present.
- `upsertTimelineItem()`: Finds existing item by `id`. If found and was `intermediate`, replaces in-place (expected path for multi-message turns). If not found, appends.
- `updateTimelineItem()`: Finds by predicate, applies updater function in-place. Used for `tool_execution_update`.

## The Timeline Model

**Files**: `src/contracts/timeline.ts` (shared types), `lib/types.ts` (re-export + WS message types)

`ChatTimelineItem` is a discriminated union:

```
ChatTimelineItem = ChatTimelineMessage | ChatTimelineTool | ChatTimelineDivider

ChatTimelineMessage {
  id, kind: "message", role, content, blocks?, images?, source?,
  streaming?, intermediate?, createdAt
}

ChatTimelineTool {
  id, kind: "tool", tool, phase: "start" | "update" | "end",
  toolUseId?, args?, result?, isError?, createdAt
}

ChatTimelineDivider {
  id, kind: "divider", createdAt
}
```

The timeline is a flat, append-only ordered list stored in the TanStack Query cache at `["pi-history", sessionId, "agent"]`. Items are never reordered — new items are appended, and existing items are updated in-place via `upsertTimelineItem` or `updateTimelineItem`.

### Key Design Details

- **`blocks`**: An assistant message may carry structured content blocks (`{ type: "text", text }` or `{ type: "thinking", thinking }`). The bridge builds these from the streaming store's accumulated text + thinking at `message_end` time.
- **`intermediate`**: Marks non-final assistant messages in multi-message turns. The upsert logic expects to replace these with the final version on `agent_end`.
- **`phase`**: Tool items progress through `"start"` -> `"update"` -> `"end"`. The `"start"` stub is created by `message_end` flush (no args), upgraded by `tool_execution_start` (adds args), transitioned to `"update"` by `tool_execution_update` (adds partial result), and a separate `"end"` item is appended by `tool_execution_end` (final result).

## The Bridge Layer

**File**: `lib/pi-web-ui-bridge.ts`

### `timelineToAgentMessages(timeline: ChatTimelineItem[]): AgentMessage[]`

Converts the flat `ChatTimelineItem[]` into the `AgentMessage[]` shape that the Lit `<message-list>` component expects.

**Algorithm**:

1. Iterate through timeline items sequentially
2. Skip dividers and already-consumed items
3. **User messages**: Map directly to `{ role: "user", content, timestamp, source }`
4. **Assistant messages**:
   - Convert `blocks` to `AssistantMessage.content` array (text + thinking blocks)
   - **Forward look-ahead**: Scan subsequent items for `tool` items with `phase: "start"` or `"update"`. Attach them as `ToolCall` content blocks within the assistant message. Mark scanned indices as consumed.
   - Result: `{ role: "assistant", content: [...text, ...thinking, ...toolCalls] }`
5. **Orphan tool starts** (no preceding assistant message): Wrap in synthetic `{ role: "assistant", content: [toolCall] }` — handles reconnect scenarios
6. **Tool ends**: Map to `{ role: "toolResult", toolCallId, toolName, content, isError }`

### `pendingToolCallsFromTimeline(timeline): Set<string>`

Scans timeline for tool items with `phase: "start"` that have no matching `phase: "end"`. Returns their `toolUseId` values. Used by `<message-list>` to mark in-progress tool calls.

### The Look-Ahead Pattern

The look-ahead that attaches tool calls to assistant messages works because `ws-query-bridge` guarantees ordering: tool stubs are appended to the query cache immediately after the assistant message (both happen in the `message_end` handler). This means tool-start items always follow their owning assistant message in the timeline.

## The Lit Rendering Layer

**File**: `pi-web-ui/chat-components.ts`

### `<message-list>` (class `MessageList`)

The top-level Lit component that renders all chat content. Manages two rendering zones within a single DOM container:

**Committed zone** — `repeat()` directive:
- Builds render items from `this.messages` via `buildRenderItems()`
- Collects all `toolResult` messages into `resultByCallId: Map<string, ToolResultMessage>`
- Skips `artifact` and `toolResult` roles (results are looked up by `<assistant-message>`)
- Uses `repeat(items, item => item.key, item => item.template)` for efficient keyed updates
- Keys are `"role:timestamp"` for stable identity across re-renders

**Streaming zone** — imperative append:
- `_streamingEl`: A single `<assistant-message>` element created on demand
- `updateStreaming(msg, isThinkingStreaming)`: Creates the element on first call, appends it after the `repeat()` container div, then sets `.message` and `.isStreaming` properties directly
- `clearStreaming()`: Hides via `display: none` inside a `requestAnimationFrame` callback — the delay ensures the committed message from the next Lit render cycle is visible before the streaming element disappears, preventing a flash

### `<assistant-message>` (class `AssistantMessage`)

Renders a single assistant message. Iterates over `message.content` blocks in order:
- `type: "text"` -> `<markdown-block>`
- `type: "thinking"` -> `<thinking-block>` (with `isStreaming` controlling shimmer animation)
- `type: "toolCall"` -> `<tool-message>` (unless `hideToolCalls` is true)
  - Looks up result in `toolResultsById` map
  - Checks `pendingToolCalls` set for in-progress state

### `<tool-message>`

Renders a tool call card with:
- Tool name and icon (mapped from known tool names)
- Arguments display (collapsible)
- Result display (from `toolResultsById` lookup)
- Pending spinner when `pending && !result`
- Error styling when `isError`

## The React Integration

### ChatPanel (`components/chat-panel.tsx`)

The React component that owns the session-level chat view. Key responsibilities:

1. **Timeline consumption**: Receives `timeline: ChatTimelineItem[]` as a prop (from the route component which merges loader history + query cache)
2. **Message conversion**: `useAgentMessages(timeline)` memoizes `timelineToAgentMessages()` — recomputes only when the timeline reference changes
3. **Streaming wiring**: A `useEffect` registers a streaming callback with `streamingStore.onStreamingDelta(sessionId, cb)`. The callback:
   - On content: Builds an `AssistantMessage` object with thinking, text, and tool call content blocks, then calls `messageListRef.current.updateStreaming(msg, isThinkingStreaming)`
   - On clear (messageId null): Calls `messageListRef.current.clearStreaming()`
4. **Ref forwarding**: Holds `messageListRef: Ref<PiMessageListHandle>` to call imperative methods on the Lit component

### PiMessageList (`components/pi-message-list.tsx`)

React wrapper for the `<message-list>` Lit custom element:

- Creates the `<message-list>` DOM element imperatively (custom elements need property assignment, not attributes, for complex types)
- Sets `.messages`, `.tools`, `.pendingToolCalls` properties on the Lit element when `messages` prop changes
- Exposes `PiMessageListHandle` via `useImperativeHandle`:
  - `updateStreaming(message, isThinkingStreaming)` -> forwards to Lit element
  - `clearStreaming()` -> forwards to Lit element
- **Custom memo equality**: `(prev, next) => prev.messages === next.messages` — skips React re-render unless the `AgentMessage[]` reference actually changes

### useAgentMessages (`hooks/use-agent-messages.ts`)

```
useMemo(() => timelineToAgentMessages(timeline), [timeline])
```

Returns a stable `AgentMessage[]` reference. Recomputes only when the `timeline` array reference changes (which happens when the query cache produces a new snapshot via `setQueryData`).

## Event Lifecycle Walkthrough

A concrete agent turn: user asks a question, agent thinks, writes text, calls a tool, gets result, writes more text.

```
Step  WS Event              Destination          Visible Effect
----  --------------------  -------------------  -----------------------------------------
 1    message_start         query cache (pill)   "Thinking..." pill appears
 2    thinking_start        streaming store      Streaming callback fires (empty thinking)
 3    thinking_delta x N    streaming store      <thinking-block> shimmer expands in
                                                 streaming <assistant-message>
 4    thinking_end          streaming store      Shimmer stops, thinking block stays open
 5    text_delta x N        streaming store      Text streams below thinking block in
                                                 streaming <assistant-message>
 6    toolcall_start        streaming store      Tool call card appears in streaming
                                                 <assistant-message> content
 7    message_end           both                 a. Committed message upserted to query cache
                                                    (with thinking + text blocks)
                                                 b. Tool stub appended to query cache
                                                 c. Streaming store cleared
                                                 d. clearStreaming() hides streaming element
                                                    (after rAF)
                                                 e. React re-renders PiMessageList with new
                                                    messages -> Lit repeat() adds committed
                                                    <assistant-message> + any tool results
 8    tool_execution_start  query cache          Tool stub upgraded with args -> React
                                                 re-render -> tool card shows args
 9    tool_execution_update query cache          Tool item phase "start"->"update" with
                                                 partial result -> card shows progress
10    tool_execution_end    query cache          Tool-end item appended -> result visible
                                                 in tool card (via resultByCallId lookup)
11    text_delta x N        streaming store      New streaming <assistant-message> appears
                                                 with continuation text
12    message_end           both                 Second committed message added, streaming
                                                 cleared
13    turn_end              streaming store      Safety clearSession() (usually no-op)
```

### The message_end Transition (Detail)

The handoff at step 7 is the most complex moment. In chronological order within a single synchronous `message_end` handler:

```
1. Build committed message (thinking blocks + text blocks)
2. upsertTimelineItem() -> query cache updated (new reference)
3. flushPendingToolCalls() -> returns buffered tools, clears pendingTools map
4. For each tool: appendTimelineItem() -> query cache updated again
5. clearSession() -> wipes texts/thinking/thinkingActive maps
6. fireCallbacks() -> cb(null, null, false, null, null)
7. ChatPanel callback fires: messageId=null -> clearStreaming()
8. clearStreaming() schedules rAF -> streaming element hidden NEXT FRAME
9. React schedules re-render (query cache changed in step 2+4)
10. React commits -> PiMessageList receives new messages prop
11. Lit element .messages setter triggers re-render
12. repeat() adds committed <assistant-message> (visible)
13. rAF fires -> streaming element hidden (but committed already visible)
```

Steps 8-13 ensure no visual flash: the committed message appears before the streaming element hides.

## Key Files Reference

| File | Role |
|------|------|
| `lib/ws-query-bridge.ts` | Event router: WS -> streaming store or query cache |
| `lib/streaming-store.ts` | Ephemeral per-session streaming state + imperative callbacks |
| `lib/pi-web-ui-bridge.ts` | Timeline -> AgentMessage[] conversion for Lit components |
| `lib/types.ts` | Re-exports shared timeline types + WS message union |
| `src/contracts/timeline.ts` | Canonical ChatTimelineItem types (shared backend/frontend) |
| `components/chat-panel.tsx` | React owner: wires streaming store to Lit component ref |
| `components/pi-message-list.tsx` | React wrapper for `<message-list>` Lit element |
| `hooks/use-agent-messages.ts` | Memoized timelineToAgentMessages conversion |
| `pi-web-ui/chat-components.ts` | Lit web components: MessageList, AssistantMessage, etc. |
