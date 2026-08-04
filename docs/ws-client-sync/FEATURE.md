# WebSocket Streaming & Client State Synchronization

Canonical reference for how server-side SDK events reach the web UI and how client state stays consistent across streaming, route switching, and page reloads.

## Architecture Overview

Flitterbot uses one server identity boundary and one client conversation-state owner. Streaming and tool progress bypass React without becoming separate state authorities.

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
  ├─► Conversation State (one reducer and one per-session record)
  │     • Streaming text/thinking and active tools share one owner
  │     • Lit web component reads imperatively via callback — zero React re-renders
  │     • Lit tool cards update imperatively by toolUseId — zero React re-renders
  │     • Streaming clears at message_end; tools clear at canonical result/turn end
  │
  └─► TanStack Query Cache (persistence layer: messages, tool calls)
        • Updated via queryClient.setQueryData() on canonical WS commits: message_end + tool_result
        • Serves navigation and canonical server snapshot replacement
        • React components subscribe via useQuery() but Lit's shouldUpdate prevents
          redundant re-renders when data was already committed imperatively
```

The server (SDK in-memory messages / JSONL session file) is the source of truth. The frontend cache is a projection that the server can always reconstruct.

## Event Flow — Normal Assistant Turn

A complete turn: user sends message → assistant thinks → responds with text → calls a tool → tool returns result → assistant sends final response.

### 1. message_start (assistant)

**Server:** Assigns a UUID owned by Flitterbot and writes it onto the Pi message object before Pi persistence. The same UUID is used by all deltas, the final live commit, and later history snapshots.

**Frontend:** Adds "Thinking..." status pill. No state layer touched.

### 2. thinking_start / thinking_delta / thinking_end

**Server:** Broadcasts each as its own WS event with `piSessionId` and `messageId`.

**Frontend → Conversation State:**
- `thinking_start` opens the identified streaming record.
- `thinking_delta` appends to that record.
- `thinking_end` marks reasoning complete.

A new `messageId` replaces the complete streaming record instead of appending to text from an earlier message. Lit renders through the conversation's single imperative subscriber. React sees nothing.

### 3. text_delta

**Server:** Broadcasts `{type: "text_delta", piSessionId, messageId, delta}`.

**Frontend → Conversation State:** The reducer appends the delta only to the matching `messageId`. Lit renders the updated record through the imperative subscriber.

### 4. toolcall_start

**Server:** Broadcasts `{type: "toolcall_start", piSessionId, toolName, toolUseId}`.

**Frontend:** No-op. Tool calls are committed via `message_end`.

### 5. message_end — The Commit Point

This is the critical event. It commits assistant message content to both the Lit component (imperatively) and the Query cache (for persistence).

**Server (`pi-subscribe.ts`):**
1. `extractMessageBlocks(event.message)` parses the SDK message content array:
   - `{type: "text"}` → `MessageBlock[]` + concatenated text string
   - `{type: "thinking"}` → `MessageBlock[]` (when non-empty)
   - `{type: "toolCall"}` → `ExtractedToolCall[]` (toolUseId, toolName, args)
2. Constructs `ChatTimelineMessage` with the Flitterbot ID and final content.
3. Broadcasts the canonical content immediately, without waiting for Pi's append timing.
4. After Pi persists the same identified message, broadcasts the same canonical ID enriched with `piEntryId`.
5. If enrichment fails, emits a session-scoped recovery error; the client keeps the canonical content and refetches history.

**Frontend (`ws-query-bridge.ts`):**
1. `conversationState.commitMessage()` performs one Query-cache transaction.
2. The transaction upserts the message and deterministic tool-start records strictly by canonical ID. The accepted web UUID is both the optimistic and canonical Flitterbot ID, so no identity swap or content matching occurs.
3. `conversationState.finishMessage()` clears only the streaming overlay; active tools remain live.
4. The `setQueryData` call persists data for navigation/refetch, but Lit's `shouldUpdate()` detects the data was already committed imperatively and returns `false` — net result: **0 React re-renders** for message_end

### 6. tool_execution_start

**Server:** Broadcasts with `tool`, `toolUseId`, `args`, `timestamp`.

**Frontend → Conversation State:** marks the tool as running in the session reducer. If the assistant message has already been committed, the matching `<tool-message>` element is updated imperatively in-place. 0 React re-renders.

### 7. tool_execution_update

**Server:** Broadcasts with `toolUseId` and `partialResult`.

**Frontend → Conversation State:** merges `partialResult` into the identified tool state and pushes it directly into the matching Lit tool card by `toolUseId`. 0 React re-renders.

### 8. tool_execution_end

**Server:** Broadcasts with `toolUseId`, `result`, `isError`.

**Frontend → Conversation State:** updates the live tool card with the final streamed result, but does **not** flush durable timeline state from the WS payload. The websocket result is treated as provisional UI progress until the server canonicalizes the turn.

### 9. tool_result — The Canonical Tool Commit Point

**Server:** When `message_end` fires with `role === "toolResult"`, the server converts that message into the canonical `ChatTimelineTool { phase: "end" }` shape and broadcasts `{type: "tool_result", item}`.

**Frontend:** `conversationState.appendLiveItem()` upserts the canonical tool result by its deterministic ID and drops its ephemeral active-tool state.

### 10. turn_end

**Server:** Broadcasts `{type: "turn_end", piSessionId}`.

**Frontend:** `conversationState.clear()` clears the session's streaming and active-tool state.

### 11. agent_end

**Server:** Broadcasts `{type: "agent_end", piSessionId, aborted?}`. The `aborted` flag is true when `messageEndFired` is false (abort skipped message_end).

**Frontend:**
- Removes typing pill
- Clears ephemeral conversation state
- If `aborted`: invalidates timeline query → triggers refetch from server session file → 1 re-render
- Normal: no cache update, no re-render (message_end already committed)

## Imperative Commit Path

The conversation owner exposes four paths to the Lit component:

**1. Conversation reducer (delta channel)** — High-frequency deltas (`text_delta`, `thinking_delta`) update the session's streaming fields. The single imperative subscriber renders the overlay. React sees nothing.

**2. Active tools (tool progress channel)** — `tool_execution_start` / `tool_execution_update` / `tool_execution_end` update the same per-session reducer record. ChatPanel's single subscriber forwards targeted updates to `messageListRef.applyActiveToolState()`.

**3. Live commits (`message_end` + `tool_result`)** — canonical events pass through the same conversation-state boundary into the newest Query page. IDs are deterministic, so commits require no content, server-ID, or tool-phase dedup heuristics.

**4. Query Cache (snapshot)** — Conversation state owns all Query writes. Refetched server snapshots replace cached snapshots canonically; unknown cached extras are not preserved.

## Tool Call Lifecycle & ID Matching

`toolUseId` is the stable server-side ID assigned by the SDK at `content_block_start`. It's the join key across the entire tool lifecycle:

| Event | Source | Action |
|---|---|---|
| `message_end` (toolCalls) | SDK content array | Creates tool item: `{toolUseId, phase: "start"}` |
| `tool_execution_start` | SDK tool_execution_start | Marks the matching tool card as running in the conversation reducer |
| `tool_execution_update` | SDK tool_execution_update | Merges `partialResult` in the conversation reducer and updates the matching tool card imperatively |
| `tool_execution_end` | SDK tool_execution_end | Updates the active tool card with the final streamed result only |
| `tool_result` | `message_end(role="toolResult")` | Appends canonical `{toolUseId, phase: "end", result}` and commits it imperatively |
| `turn_end` | SDK turn_end | Clears any remaining ephemeral state |

## Thinking Trace Lifecycle

Thinking traces flow through both state layers:

1. **Live streaming** (conversation reducer): `thinking_start` → `thinking_delta(s)` → `thinking_end`. Lit component renders the expanding text via imperative callback. No React involvement.

2. **Commit** (Query cache): `message_end` carries `blocks: [{type: "thinking", thinking: "..."}, {type: "text", text: "..."}]` extracted from the SDK message. Committed atomically alongside text blocks in the single `setQueryData` call.

3. **Persistence**: The SDK's in-memory `session.messages` array and the JSONL session file both contain the full content blocks including thinking. The server's history API (`readStreamsHistoryFromMessages` → `parseMessageContent`) extracts thinking blocks into the `ChatTimelineMessage.blocks` field.

4. **Survival across route switches**: Server is source of truth. When navigating away and back, TanStack Query accepts the canonical server snapshot. Thinking blocks survive because the server always has them.

## Ordered Replay, Snapshots, and Revalidation

### Stable conversation identity

```ts
type PersistedPiMessage = AgentMessage & { flitterbotMessageId: string }
type ChatTimelineMessage = {
  id: string                 // flitterbotMessageId: canonical UI identity
  piEntryId: string          // Pi JSONL entry id: prune/fork persistence handle
}

message_start(message)
  -> ensureFlitterbotMessageId(message)
  -> stream deltas(message.id)
  -> Pi appends { id: piEntryId, message: { flitterbotMessageId } }

message_end(message)
  -> broadcast timeline item { id: flitterbotMessageId }
  -> resolve the persisted JSONL entry by flitterbotMessageId
  -> broadcast the same item enriched with { piEntryId }

history snapshot
  -> parse JSONL entry
  -> { id: message.flitterbotMessageId ?? piEntryId, piEntryId }
```

Legacy JSONL without `flitterbotMessageId` remains readable and uses its Pi entry ID for both identities. Pi entry IDs are never inferred from the current leaf.

### Client state boundary

```text
<ChatPanel>
  -> conversationState (one per-session owner)
     -> snapshot reducer (server history + optimistic reconciliation)
     -> live reducer (message_end + tool_result)
     -> streaming overlay (imperative delta callback)
     -> active tools (imperative keyed callback)
  -> <MessageList> (rendered snapshot plus imperative hot-path updates)
```

TanStack Query stores paginated snapshots, but `conversation-state.ts` owns every snapshot, live, optimistic, streaming, tool, and surface mutation.

Each replayable server event carries `{incarnation, sequence}`. The client rejects duplicate positions and detects gaps. On reconnect or route return, it subscribes after its last position. The server replays from one bounded global buffer. An expired cursor or changed runtime incarnation emits `conversation_reset`, clears ephemeral state, and refetches the authoritative JSONL snapshot.

Snapshot replacement overlays only records explicitly tracked as pending optimistic or live commits. It never preserves arbitrary cache extras. Once a snapshot contains a canonical ID, the reducer removes that pending record.

**When revalidation happens:**
- WebSocket reconnect;
- replay gap, expired cursor, or runtime incarnation change;
- `history_rewritten` after prune or compaction;
- aborted generation;
- persistence-enrichment failure.

**When the active stream route changes:** `setupWsRouteSubscriptions()` receives TanStack Router's `onResolved` event, clears the previous session's ephemeral streaming state, then swaps the server subscription. Navigation from the sidebar, shortcuts, redirects, and other router-driven paths therefore share the same cleanup contract.

## Re-render Budget

| Event | setQueryData calls | React re-renders |
|---|---|---|
| text_delta | 0 | 0 (conversation reducer → Lit) |
| thinking_delta | 0 | 0 (conversation reducer → Lit) |
| message_end | 1 (message + tool calls atomic) + 1 imperative commit | 0 (Lit `shouldUpdate` suppresses React catch-up) |
| tool_execution_start | 0 | 0 (conversation reducer → targeted Lit tool card) |
| tool_execution_update | 0 | 0 (conversation reducer → targeted Lit tool card) |
| tool_execution_end | 0 | 0 (conversation reducer → targeted Lit tool card) |
| tool_result | 1 (append canonical end item) + 1 imperative tool-result commit | 0 |
| turn_end | 0 | 0 |
| agent_end (normal) | 0 | 0 |
| agent_end (aborted) | 0 + 1 invalidation → refetch | 1 |

A typical assistant turn with thinking + text + 1 tool call: 0 React re-renders on the green path. All high-frequency deltas, live tool progress, and canonical tool flushes are zero-cost to React.

## Key Files

| File | Role |
|---|---|
| `src/streams/pi-subscribe.ts` | Server: SDK event subscription → WS broadcast. `extractMessageBlocks()` extracts text, thinking, and tool calls. |
| `src/contracts/websocket.ts` | WS event identity, position, replay-resume, and reset contracts |
| `src/streams/history.ts` | Server: parses SDK messages / JSONL session file → `ChatTimelineItem[]` for history API |
| `web/src/lib/conversation-state.ts` | Frontend: sole per-session reducer/owner for snapshots, live commits, optimistic rows, streaming, and active tools. |
| `src/ws/hub.ts` | Assigns monotonic per-session positions and serves bounded replay. |
| `web/src/lib/ws-query-bridge.ts` | Translates ordered WS events into conversation-state actions. |
| `web/src/lib/queries.ts` | Frontend: TanStack Query options with canonical snapshot replacement. |
| `web/src/hooks/use-streams-chat.ts` | Frontend: React hook wiring timeline query to chat components |
| `web/src/lib/types.ts` | Frontend: `WsMessage` union type, `ChatTimelineItem` types |
