# WebSocket Streaming & Client State Synchronization

Canonical reference for how server-side SDK events reach the web UI and how client state stays consistent across streaming, route switching, and page reloads.

## Architecture Overview

Three layers, three state paths, zero React re-renders during streaming, active tool progress, and message commit.

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
  ├─► Streaming Store (all ephemeral per-session state — not React state)
  │     • Text/thinking deltas: Plain Map<sessionId, text/thinking> at ~30Hz
  │     • Tool call cards: toolcall_start appends to streaming content for early rendering
  │     • Active tool progress: tool_execution_start/update/end keyed by toolUseId
  │     • Lit web component reads imperatively via callbacks — zero React re-renders
  │     • Cleared on message_end / turn_end / agent_end
  │
  ├─► Imperative Commit (message_end + tool_result)
  │     • streamingStore.commitMessage() → ChatPanel onCommit → Lit commitStreaming()
  │     • Converts timeline items to AgentMessages, appends only new items to Lit
  │     • Lit's shouldUpdate() suppresses the redundant React catch-up render
  │
  └─► TanStack Query Cache (persistence layer: messages, tool calls)
        • Updated via queryClient.setQueryData() on canonical WS commits: message_end + tool_result
        • Serves navigation, refetch, mergeTimelineItems reconciliation
        • React components subscribe via useQuery() but Lit's shouldUpdate prevents
          redundant re-renders when data was already committed imperatively
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

**Frontend → Streaming Store:** `appendToolCall(sid, {type: "toolCall", id: toolUseId, name: toolName, arguments: {}})`. The streaming callback fires, and the Lit component renders `<tool-message>` cards inside the streaming `<assistant-message>` overlay. This ensures tool-message DOM elements exist **before** `message_end` commits, so `commitToolResult` can find its target without queuing.

### 5. message_end — The Commit Point

This is the critical event. It commits assistant message content to both the Lit component (imperatively) and the Query cache (for persistence).

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
   - Appends tool call start items from `message.toolCalls`, deduped by `toolUseId` (skips items where an active tool with the same `toolUseId` and `phase !== "end"` already exists — prevents duplicates when the cache already has tool starts from a prior server fetch)
2. Imperative commit: `timelineItemsToAgentMessages(committedItems)` → `streamingStore.commitMessage()` → ChatPanel `onCommit` callback → `messageListRef.commitStreaming()` → Lit appends only new items
3. `streamingStore.clearSession()` — clears streaming overlay
4. The `setQueryData` call persists data for navigation/refetch, but Lit's `shouldUpdate()` detects the data was already committed imperatively and returns `false` — net result: **0 React re-renders** for message_end

### 6. tool_execution_start

**Server:** Broadcasts with `tool`, `toolUseId`, `args`, `timestamp`.

**Frontend → Streaming Store:** `streamingStore.upsertTool()` marks the tool as running in the ephemeral tool state. If the assistant message has already been committed, the matching `<tool-message>` element is updated imperatively in-place. 0 React re-renders.

### 7. tool_execution_update

**Server:** Broadcasts with `toolUseId` and `partialResult`.

**Frontend → Streaming Store:** merges `partialResult` into the ephemeral tool state and pushes it directly into the matching Lit tool card by `toolUseId`. 0 React re-renders.

### 8. tool_execution_end

**Server:** Broadcasts with `toolUseId`, `result`, `isError`.

**Frontend → Streaming Store:** updates the live tool card with the final streamed result, but does **not** flush durable timeline state from the WS payload. The websocket result is treated as provisional UI progress until the server canonicalizes the turn.

### 9. tool_result — The Canonical Tool Commit Point

**Server:** When `message_end` fires with `role === "toolResult"`, the server converts that message into the canonical `ChatTimelineTool { phase: "end" }` shape and broadcasts `{type: "tool_result", item}`.

**Frontend:** `appendTimelineItem()` persists the canonical tool result into the Query cache, then `timelineItemsToAgentMessages([item])` → `streamingStore.commitToolResult()` → ChatPanel `onToolResultCommit` → `messageListRef.commitToolResult()` updates only the matching Lit tool card and suppresses the subsequent React catch-up render.

### 10. turn_end

**Server:** Broadcasts `{type: "turn_end", piSessionId}`.

**Frontend:** `streamingStore.clearSession()` — safety-net cleanup for text/thinking overlays. Any still-live active tool state is also cleared.

### 11. agent_end

**Server:** Broadcasts `{type: "agent_end", piSessionId, aborted?}`. The `aborted` flag is true when `messageEndFired` is false (abort skipped message_end).

**Frontend:**
- Removes typing pill
- Clears streaming store
- If `aborted`: invalidates timeline query → triggers refetch from server session file → 1 re-render
- Normal: no cache update, no re-render (message_end already committed)

## Imperative Commit Path

Three-layer architecture for getting data from WS events to the Lit component:

**1. Streaming Store (delta + tool progress channel)** — All ephemeral per-session state lives in `streaming-store.ts`. High-frequency deltas (`text_delta`, `thinking_delta`) at ~30Hz accumulate text in a plain `Map`. `toolcall_start` events append tool cards to the streaming content for early rendering. `tool_execution_start` / `tool_execution_update` / `tool_execution_end` events maintain active tool state keyed by `toolUseId`. ChatPanel subscribes to streaming deltas via `onStreamingDelta` and to tool progress via `onActiveToolUpdate`, forwarding updates imperatively to the Lit component. `MessageList` keeps a `toolUseId -> <tool-message>` index and mutates only the matching tool card. React sees nothing.

**2. Imperative Commit (message_end + tool_result)** — canonical server commits are pushed into the current Lit UI without going through a full React render cycle. For assistant/user `message_end`, `ws-query-bridge` builds `committedItems`, converts them to `AgentMessage[]`, then calls `streamingStore.commitMessage()` → ChatPanel `onCommit` → `messageListRef.commitStreaming()` → Lit `MessageList.commitStreaming()`. For canonical `tool_result`, `ws-query-bridge` converts the single timeline item into a `toolResult` AgentMessage and calls `streamingStore.commitToolResult()` → ChatPanel `onToolResultCommit` → `messageListRef.commitToolResult()` → Lit updates only the matching tool card. Both paths set `_committedTotal` so the subsequent React catch-up render is suppressed.

**3. Query Cache (persistence)** — `setQueryData` runs on canonical WS commits for persistence: `message_end` for assistant/user messages and `tool_result` for tool results. It remains the source of truth for navigation, refetch reconciliation (`mergeTimelineItems`), and server revalidation. React components subscribe via `useQuery()`, but the hot path never depends on React renders.

## Tool Call Lifecycle & ID Matching

`toolUseId` is the stable server-side ID assigned by the SDK at `content_block_start`. It's the join key across the entire tool lifecycle:

| Event | Source | Action |
|---|---|---|
| `toolcall_start` | SDK content_block_start | `streamingStore.appendToolCall()` — renders `<tool-message>` in streaming overlay |
| `message_end` (toolCalls) | SDK content array | Creates tool item: `{toolUseId, phase: "start"}` |
| `tool_execution_start` | SDK tool_execution_start | `streamingStore.upsertTool()` — marks matching tool card as running |
| `tool_execution_update` | SDK tool_execution_update | `streamingStore.upsertTool()` — merges `partialResult` and updates matching tool card imperatively |
| `tool_execution_end` | SDK tool_execution_end | `streamingStore.upsertTool()` — updates tool card with final streamed result only |
| `tool_result` | `message_end(role="toolResult")` | Appends canonical `{toolUseId, phase: "end", result}` and commits it imperatively |
| `turn_end` | SDK turn_end | `streamingStore.clearSession()` — clears all ephemeral state |

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
3. If no extras: return canonical server data (always prefer fresh content over cached snapshots — the ID-only equality check was removed because same IDs doesn't mean same content, e.g. cached version had incomplete thinking blocks from intermediate WS snapshots)
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
| toolcall_start | 0 | 0 (streaming store → Lit streaming overlay) |
| message_end | 1 (message + tool calls atomic) + 1 imperative commit | 0 (Lit `shouldUpdate` suppresses React catch-up) |
| tool_execution_start | 0 | 0 (streaming store → targeted Lit tool card) |
| tool_execution_update | 0 | 0 (streaming store → targeted Lit tool card) |
| tool_execution_end | 0 | 0 (streaming store → targeted Lit tool card) |
| tool_result | 1 (append canonical end item) + 1 imperative tool-result commit | 0 |
| turn_end | 0 | 0 |
| agent_end (normal) | 0 | 0 |
| agent_end (aborted) | 0 + 1 invalidation → refetch | 1 |

A typical assistant turn with thinking + text + 1 tool call: 0 React re-renders on the green path. All high-frequency deltas, live tool progress, and canonical tool flushes are zero-cost to React.

## Key Files

| File | Role |
|---|---|
| `src/streams/pi-subscribe.ts` | Server: SDK event subscription → WS broadcast. `extractMessageBlocks()` extracts text, thinking, and tool calls. |
| `src/contracts/websocket.ts` | WS event type contracts (shared between server and frontend types) |
| `src/streams/history.ts` | Server: parses SDK messages / JSONL session file → `ChatTimelineItem[]` for history API |
| `web/src/lib/streaming-store.ts` | Frontend: unified imperative store for all ephemeral per-session state — text/thinking deltas, streaming toolCalls, active tool execution progress, and commit channels for message_end and canonical tool_result flushes |
| `web/src/lib/ws-query-bridge.ts` | Frontend: routes WS events → streaming store or Query cache. Contains atomic message_end handler and canonical tool_result flush. |
| `web/src/lib/queries.ts` | Frontend: TanStack Query options + `mergeTimelineItems` structuralSharing |
| `web/src/hooks/use-streams-chat.ts` | Frontend: React hook wiring timeline query to chat components |
| `web/src/lib/types.ts` | Frontend: `WsMessage` union type, `ChatTimelineItem` types |
