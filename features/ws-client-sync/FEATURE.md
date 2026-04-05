# WebSocket Streaming & Client State Synchronization

Canonical reference for how server-side SDK events reach the web UI and how client state stays consistent across streaming, route switching, and page reloads.

## Architecture Overview

Three layers, two state stores, zero React re-renders during streaming.

```
PI SDK (Claude)
  │  events: message_start, message_update, message_end, tool_*, turn_end, agent_end
  ▼
pi-subscribe.ts ── subscribes to SDK session events
  │  extracts structured data (text, thinking blocks, tool calls)
  │  broadcasts typed WS events to all connected clients
  ▼
WebSocket transport
  ▼
ws-query-bridge.ts ── routes WS events to the correct state layer
  │
  ├─► Streaming Store (high-frequency deltas: text_delta, thinking_delta)
  │     • Plain Map<sessionId, text/thinking> — not React state
  │     • Lit web component reads imperatively via callback — zero React re-renders
  │     • Cleared on message_end / turn_end / agent_end
  │
  └─► TanStack Query Cache (committed state: messages, tool calls)
        • Updated via queryClient.setQueryData() on message_end, tool_execution_*
        • React components subscribe via useQuery() — re-renders on cache update
        • Persists across route switches; revalidated from server on mount
```

The server (SDK in-memory messages / JSONL session file) is the source of truth. The frontend cache is a projection that the server can always reconstruct.

## Event Flow — Normal Assistant Turn

A complete turn: user sends message → assistant thinks → responds with text → calls a tool → tool returns result → assistant sends final response.

### 1. message_start (assistant)

**Server:** Assigns ordinal message ID (`msg-N`), broadcasts `{type: "message_start", piSessionId, messageId}`.

**Frontend:** Adds "Thinking..." status pill. No state layer touched.

### 2. thinking_start / thinking_delta / thinking_end

**Server:** Broadcasts each as its own WS event with `piSessionId` and `messageId`.

**Frontend → Streaming Store:**
- `thinking_start` → `setThinkingStreaming(sid, true, msgId)` — pre-initializes entry, removes typing pill
- `thinking_delta` → `appendThinkingDelta(sid, msgId, delta)` — accumulates text
- `thinking_end` → `setThinkingStreaming(sid, false)`

Lit component renders thinking live via imperative callback. React sees nothing.

### 3. text_delta

**Server:** Broadcasts `{type: "text_delta", piSessionId, messageId, delta}`.

**Frontend → Streaming Store:** `appendTextDelta(sid, msgId, delta)`. Removes typing pill on first delta. Lit component renders live.

### 4. toolcall_start

**Server:** Broadcasts `{type: "toolcall_start", piSessionId, toolName, toolUseId}`.

**Frontend:** No-op. Tool calls are committed via `message_end`.

### 5. message_end — The Commit Point

This is the critical event. It's the only point where assistant message content enters the React render cycle.

**Server (`pi-subscribe.ts`):**
1. `extractMessageBlocks(event.message)` parses the SDK message content array:
   - `{type: "text"}` → `MessageBlock[]` + concatenated text string
   - `{type: "thinking"}` → `MessageBlock[]` (when non-empty)
   - `{type: "toolCall"}` → `ExtractedToolCall[]` (toolUseId, toolName, args)
2. Constructs `ChatTimelineMessage` with `content` (text) and `blocks` (when thinking present)
3. Broadcasts `{type: "message_end", piSessionId, message, toolCalls?}`
4. Sets `messageEndFired = true` for abort detection

**Frontend (`ws-query-bridge.ts`):**
1. ONE atomic `queryClient.setQueryData()` call that:
   - Upserts the message by ID (replace if exists, append if new)
   - Appends tool call start items from `message.toolCalls`
2. `streamingStore.clearSession()` — Lit component switches from streaming overlay to committed content
3. Single React re-render from the cache update

### 6. tool_execution_start

**Server:** Broadcasts with `tool`, `toolUseId`, `args`, `timestamp`.

**Frontend → Query Cache:** `upsertActiveToolItem()` finds the existing tool item by `toolUseId` (phase !== "end") and merges `args` and `tool` name in-place. 1 re-render.

### 7. tool_execution_update

**Server:** Broadcasts with `toolUseId` and `partialResult`.

**Frontend → Query Cache:** `upsertActiveToolItem()` merges `partialResult` into existing tool item. 1 re-render.

### 8. tool_execution_end

**Server:** Broadcasts with `toolUseId`, `result`, `isError`.

**Frontend → Query Cache:** `appendTimelineItem()` adds a new tool item with `phase: "end"`. Deduped by toolUseId + phase. 1 re-render.

### 9. turn_end

**Server:** Broadcasts `{type: "turn_end", piSessionId}`.

**Frontend:** `streamingStore.clearSession()` — safety net cleanup. No cache update, no re-render.

### 10. agent_end

**Server:** Broadcasts `{type: "agent_end", piSessionId, aborted?}`. The `aborted` flag is true when `messageEndFired` is false (abort skipped message_end).

**Frontend:**
- Removes typing pill
- Clears streaming store
- If `aborted`: invalidates timeline query → triggers refetch from server session file → 1 re-render
- Normal: no cache update, no re-render (message_end already committed)

## Tool Call Lifecycle & ID Matching

`toolUseId` is the stable server-side ID assigned by the SDK at `content_block_start`. It's the join key across the entire tool lifecycle:

| Event | Source | Action |
|---|---|---|
| `message_end` (toolCalls) | SDK content array | Creates tool item: `{toolUseId, phase: "start"}` |
| `tool_execution_start` | SDK tool_execution_start | Finds by `toolUseId` (phase !== "end"), merges `args` + `tool` name |
| `tool_execution_update` | SDK tool_execution_update | Finds by `toolUseId` (phase !== "end"), merges `partialResult` |
| `tool_execution_end` | SDK tool_execution_end | Appends new item: `{toolUseId, phase: "end", result}` |

The `upsertActiveToolItem()` helper handles the find-and-merge pattern. It searches for an existing item matching `toolUseId` with `phase !== "end"` and replaces it with the merged result. If no match, it appends.

## Thinking Trace Lifecycle

Thinking traces flow through both state layers:

1. **Live streaming** (streaming store): `thinking_start` → `thinking_delta(s)` → `thinking_end`. Lit component renders the expanding text via imperative callback. No React involvement.

2. **Commit** (Query cache): `message_end` carries `blocks: [{type: "thinking", thinking: "..."}, {type: "text", text: "..."}]` extracted from the SDK message. Committed atomically alongside text blocks in the single `setQueryData` call.

3. **Persistence**: The SDK's in-memory `session.messages` array and the JSONL session file both contain the full content blocks including thinking. The server's history API (`readStreamsHistoryFromMessages` → `parseMessageContent`) extracts thinking blocks into the `ChatTimelineMessage.blocks` field.

4. **Survival across route switches**: Server is source of truth. When navigating away and back, TanStack Query revalidates from the server. `mergeTimelineItems` reconciles WS-accumulated items with server data. Thinking blocks survive because the server always has them.

## Dedup & Revalidation

The `streamsHistoryQueryOptions` uses `structuralSharing: mergeTimelineItems` to reconcile server-fetched data with WS-accumulated cache on every refetch.

**How `mergeTimelineItems` works:**

1. Build a `serverIds` set from the fetched data: `id`, `serverMessageId`, and `toolUseId` values
2. Filter the old cache for "extras" — items whose identity isn't in `serverIds`
3. If no extras: return old reference if IDs match (referential equality → no re-render), otherwise return server data
4. If extras exist: return `[...serverData, ...extras]` (WS-accumulated items the server doesn't know about yet are preserved)

**When revalidation happens:**
- `refetchOnMount: "always"` — every route mount triggers background refetch
- WS reconnection — invalidates all `streams-history` queries
- `agent_end` with `aborted: true` — invalidates the specific session's timeline

## Re-render Budget

| Event | setQueryData calls | React re-renders |
|---|---|---|
| text_delta | 0 | 0 (streaming store → Lit) |
| thinking_delta | 0 | 0 (streaming store → Lit) |
| message_end | 1 (message + tool calls atomic) | 1 |
| tool_execution_start | 1 (upsert in-place) | 1 |
| tool_execution_update | 1 (upsert in-place) | 1 |
| tool_execution_end | 1 (append) | 1 |
| turn_end | 0 | 0 |
| agent_end (normal) | 0 | 0 |
| agent_end (aborted) | 0 + 1 invalidation → refetch | 1 |

A typical assistant turn with thinking + text + 1 tool call: 4 React re-renders total. All high-frequency deltas are zero-cost to React.

## Key Files

| File | Role |
|---|---|
| `src/streams/pi-subscribe.ts` | Server: SDK event subscription → WS broadcast. `extractMessageBlocks()` extracts text, thinking, and tool calls. |
| `src/contracts/websocket.ts` | WS event type contracts (shared between server and frontend types) |
| `src/streams/history.ts` | Server: parses SDK messages / JSONL session file → `ChatTimelineItem[]` for history API |
| `web/src/lib/streaming-store.ts` | Frontend: imperative Map-based store for high-frequency text/thinking deltas |
| `web/src/lib/ws-query-bridge.ts` | Frontend: routes WS events → streaming store or Query cache. Contains `appendTimelineItem`, `upsertActiveToolItem`, atomic message_end handler. |
| `web/src/lib/queries.ts` | Frontend: TanStack Query options + `mergeTimelineItems` structuralSharing |
| `web/src/hooks/use-streams-chat.ts` | Frontend: React hook wiring timeline query to chat components |
| `web/src/lib/types.ts` | Frontend: `WsMessage` union type, `ChatTimelineItem` types |
