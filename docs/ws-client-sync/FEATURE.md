# WebSocket Streaming and Client State Synchronization

Canonical reference for how server SDK events reach the web chat and how client state stays consistent across streaming, route changes, replay, and snapshots.

## Architecture

Flitterbot has one server identity boundary and one client conversation-state owner.

```text
Pi assistant content events
  → pi-subscribe translates each block by (messageId, contentIndex)
    → positioned assistant_block_set / assistant_block_delta events
    → authoritative assistant_message_snapshot on subscription
      → ws-query-bridge
        ├─ conversationState ordered block snapshots
        ├─ conversationState active tool progress by toolUseId
        └─ TanStack Query committed timeline and paginated snapshots
```

The SDK session and JSONL file are authoritative. TanStack Query stores the committed browser projection. `conversation-state.ts` owns the incomplete ordered assistant message and active tool execution snapshots. `ws-query-bridge.ts` owns event routing and canonical query writes.

React renders the complete chat tree directly. There is no custom-element bridge or second message-content model. Live and committed rows use `ChatTimelineMessageBlock[]` and the same content-part builder.

## Pseudocode Contracts and Call Graph

```ts
type AssistantBlockSet = {
  messageId: string
  contentIndex: number
  block: ChatTimelineMessageBlock
  tool?: ChatTimelineTool
  active: boolean
}

type AssistantBlockDelta = {
  messageId: string
  contentIndex: number
  blockType: "text" | "thinking"
  delta: string
}

type AssistantMessageSnapshot = {
  messageId: string
  blocks: Array<{ block: ChatTimelineMessageBlock; tool?: ChatTimelineTool; active: boolean }>
}
```

```text
Pi message_update
  → pi-subscribe preserves contentIndex and tool-call starts
    → WebSocketHub positions and replays block events
      → ws-query-bridge
        → conversationState.blocks: Map<contentIndex, block>
          → StreamingAssistantRow
            → buildConversationContentParts

Pi message_end / JSONL history
  → piMessageToTimelineItems
    → ChatTimelineMessageBlock[]
      → buildConversationContentParts
```

## Component Tree

```text
ChatPanel
  → StreamsMessageList(ChatTimelineItem[])
    → TanStack Virtual measured rows
      ├─ ChatMessageRow
      │   └─ AssistantContents(buildConversationContentParts)
      ├─ ToolMessage → useConversationToolState(toolUseId)
      └─ StreamingAssistantRow → useConversationStreaming()
          └─ AssistantContents(buildConversationContentParts)
```

## Assistant Turn

### Message identity and deltas

At `message_start`, the server assigns a Flitterbot UUID to the Pi message before persistence. Every block event, commit, and history snapshot uses that UUID.

Pi identifies each text, thinking, or tool-call block with `contentIndex`. `assistant_block_set` creates or replaces that exact slot at block start and end. `assistant_block_delta` appends text or thinking only within the matching slot. Tool-call starts therefore create an ordered boundary before tool execution begins. The store publishes at most one immutable snapshot per animation frame; the first snapshot for a different `messageId` publishes immediately and replaces the previous incomplete message.

### `message_end`: canonical message commit

`pi-subscribe.ts` extracts ordered text, thinking, and tool-reference blocks, image attachments, and deterministic tool-start items from the final SDK message. A tool-reference block keeps each card at its original position among text and thinking. Image-only messages remain canonical live commits instead of waiting for a history refetch. After Pi persists the message, the server broadcasts the same canonical message ID with its `piEntryId` persistence handle.

`ws-query-bridge.ts` upserts the message and tool starts into the newest infinite-query page, then calls `finishMessage()` to remove the incomplete snapshot. The live and committed rows have the same message identity, block order, and content-part projection. `event.message` on Pi's final `message_end` remains authoritative because abort or error can interrupt blocks without matching end events; terminal replacement finalizes protocol state rather than repairing inferred ordering.

### Tool lifecycle

`toolUseId` joins all phases of a tool call:

- Tool-call start creates the indexed boundary and publishes a typed card as soon as Pi supplies its ID and name.
- Tool-call deltas replace that indexed card with Pi's cumulative parsed arguments.
- Tool-call end marks the call block complete with final arguments; it does not contain the execution result.
- `message_end` commits canonical `{phase: "start"}` timeline items and ordered `{type: "tool", toolUseId}` message blocks.
- `tool_execution_start` marks the active tool as pending.
- `tool_execution_update` replaces or extends its partial result.
- `tool_execution_end` records the provisional final result and error state.
- `tool_result` appends the canonical `{phase: "end"}` timeline item and removes the transient tool snapshot.
- `turn_end` and `agent_end` clear remaining transient state.

Each visible `ToolMessage` subscribes to its own `toolUseId` channel. Streaming and tool listeners are separate, and tool listeners are keyed by ID, so a mutation notifies and rerenders only the affected card.

### Thinking traces

The incomplete snapshot stores blocks in a `Map` keyed by `contentIndex`, with activity on each block because Pi can interleave block lifecycles. An empty thinking slot remains invisible, including encrypted-only reasoning. `buildConversationContentParts()` renders each maximal contiguous run of readable thinking blocks as one disclosure. Nonempty text, tool references, and a new assistant message terminate the run. The disclosure animates when its run contains any active readable block. History parsing reconstructs the same ordered block types from the SDK message or JSONL file, so navigation and reload use the same projection.

### Agent completion

A successful empty assistant message can emit no block events or zero-delta block start/end pairs; its empty `message_end` still clears incomplete browser state. A normal `agent_end` clears remaining transient state because canonical events have already committed the turn. An aborted `agent_end` also invalidates history so the browser reconstructs the authoritative final message from the server file.

## Canonical Identity

```ts
type ChatTimelineMessage = {
  id: string       // Flitterbot message identity used by live events and history
  piEntryId?: string // persisted Pi JSONL entry used by prune and fork actions
}
```

Legacy JSONL entries without a Flitterbot UUID use the Pi entry ID as their timeline identity. The UI never infers a persistence handle from content or from the current transcript leaf.

`buildConversationRows()` pairs tool starts and ends by `toolUseId`, coalesces repeated tool updates at the first call position, and assigns deterministic collision-safe row keys. Ordered tool-reference blocks preserve text/tool/text and thinking/tool/text chronology. The final assistant row in each user turn owns the copy action for that turn.

## Ordered Replay and Snapshots

Every replayable event carries `{incarnation, sequence}`.

- The client rejects duplicate or older sequences.
- A gap starts recovery and triggers snapshot revalidation plus subscription resume.
- `conversation_reset` installs the new incarnation position, clears incomplete state, and refetches history.
- After subscription and replay, `WebSocketHub` sends the current in-flight assistant snapshot without advancing the positioned sequence. This restores every indexed block after reset without seeding synthetic blocks or waiting for `message_end`.
- Snapshot reconciliation overlays only explicitly pending canonical and optimistic items.
- Reset records prior runtime incarnations as superseded. Late events and snapshots from those incarnations are ignored, while an unknown authoritative incarnation can establish a newer ledger during WebSocket downtime.
- Each history request carries a local generation tag. Reset, rewrite, and replay-gap recovery invalidate older in-flight responses.
- A same-incarnation network response cannot move the accepted sequence backward.
- Once a matching snapshot covers a pending item by canonical ID or watermark, the reducer removes that overlay.

Revalidation occurs after reconnect, replay gaps, runtime-incarnation changes, history rewrites, aborted generation, and persistence-enrichment errors.

When the active route changes, `setupWsRouteSubscriptions()` clears the previous session's transient state before it changes the server subscription. Session routes subscribe to their exact `piSessionId`; Surface subscribes to the wildcard with only `error` and `stream_surfaced` events. Before position acceptance or dispatch, `FlitterbotWsClient` rejects events that do not match that active target. Leaving Surface removes its query cache. After the server installs a wildcard subscription, its `subscribed` acknowledgement resets the Surface query to one authoritative newest page; the same acknowledgement repairs Surface after reconnect. Scoped errors also pass: active-session errors recover immediately, while errors received on Surface mark that session history stale without reloading it or showing a toast. `<StreamsMessageList key={piSessionId}>` remounts the virtualizer and initial-bottom state for the new conversation.

## Render Boundaries

- Assistant block events update only `StreamingAssistantRow`; committed rows and `ChatPanel` do not subscribe.
- Tool progress updates only the matching visible `ToolMessage` snapshot.
- Canonical `message_end` and `tool_result` events update TanStack Query and rebuild committed rows once from `ChatTimelineItem[]`.
- Streaming Markdown parsing is frame-bound and code highlighting waits for commit.
- TanStack Virtual owns row measurement, bottom anchoring, append following, and prepend preservation.

## Key Files

- `src/streams/pi-subscribe.ts` — SDK events, canonical IDs, message blocks, and WebSocket broadcasts.
- `src/contracts/websocket.ts` — event contracts, positions, replay resume, and reset.
- `src/streams/history.ts` — SDK/JSONL history to `ChatTimelineItem[]`.
- `src/ws/hub.ts` — monotonic session positions and bounded replay.
- `web/src/lib/ws-query-bridge.ts` — event routing into conversation state.
- `web/src/lib/conversation-state.ts` — indexed incomplete-message blocks, frame-bound snapshots, active tools, and hooks.
- `web/src/lib/conversation-rows.ts` — shared live/committed content grouping, direct row derivation, and tool pairing.
- `web/src/components/streams-message-list.tsx` — React-owned TanStack Virtual list.
- `web/src/components/chat-message-row.tsx` — committed and transient message rows.
- `web/src/components/chat-tool-message.tsx` — specialized tool cards and localized tool subscriptions.
