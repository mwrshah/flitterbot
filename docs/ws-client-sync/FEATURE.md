# WebSocket Streaming and Client State Synchronization

Canonical reference for how server SDK events reach the web chat and how client state stays consistent across streaming, route changes, replay, and snapshots.

## Architecture

Flitterbot has one server identity boundary and one client conversation-state owner.

```text
Pi SDK events
  → src/streams/pi-subscribe.ts
    → typed, positioned WebSocket events
      → web/src/lib/ws-query-bridge.ts
        ├─ conversationState transient snapshots
        │    ├─ streaming text and thinking by messageId
        │    └─ active tool progress by toolUseId
        └─ TanStack Query canonical timeline
             ├─ committed messages and tool results
             ├─ optimistic user messages
             └─ paginated server snapshots

ChatPanel
  → StreamsMessageList(ChatTimelineItem[])
    → TanStack Virtual measured rows
      ├─ committed ChatMessageRow
      ├─ ToolMessage → useConversationToolState(toolUseId)
      └─ StreamingAssistantRow → useConversationStreaming()
```

The SDK session and JSONL file are authoritative. TanStack Query stores the canonical browser projection. `conversation-state.ts` owns canonical cache writes, optimistic reconciliation, ordered-event state, streaming snapshots, and active tools.

React renders the complete chat tree directly. There is no custom-element bridge or second Pi-message representation. `ChatTimelineItem[]` is the render contract.

## Assistant Turn

### Message identity and deltas

At `message_start`, the server assigns a Flitterbot UUID to the Pi message before persistence. Every thinking delta, text delta, live commit, and later history snapshot uses that UUID.

`thinking_start`, `thinking_delta`, `thinking_end`, and `text_delta` append immediately to the matching `messageId`. The conversation store publishes at most one immutable snapshot per animation frame; the first snapshot for a different `messageId` publishes immediately and replaces the prior accumulation. `StreamingAssistantRow` is the only text-stream subscriber.

### `message_end`: canonical message commit

`pi-subscribe.ts` extracts ordered text, thinking, and tool-reference blocks, image attachments, and deterministic tool-start items from the final SDK message. A tool-reference block keeps each card at its original position among text and thinking. Image-only messages remain canonical live commits instead of waiting for a history refetch. After Pi persists the message, the server broadcasts the same canonical message ID with its `piEntryId` persistence handle.

`ws-query-bridge.ts` calls `conversationState.commitMessage()`, which upserts the message and tool starts into the newest infinite-query page in one cache transaction. `finishMessage()` then removes the transient streaming snapshot. The virtual list renders the canonical row with the same identity and no content-matching adapter.

### Tool lifecycle

`toolUseId` joins all phases of a tool call:

- `message_end` tool calls create canonical `{phase: "start"}` timeline items and ordered `{type: "tool", toolUseId}` message blocks.
- `tool_execution_start` marks the active tool as pending.
- `tool_execution_update` replaces or extends its partial result.
- `tool_execution_end` records the provisional final result and error state.
- `tool_result` appends the canonical `{phase: "end"}` timeline item and removes the transient tool snapshot.
- `turn_end` and `agent_end` clear remaining transient state.

Each visible `ToolMessage` subscribes to its own `toolUseId` channel. Streaming and tool listeners are separate, and tool listeners are keyed by ID, so a mutation notifies and rerenders only the affected card.

### Thinking traces

The transient snapshot carries growing thinking text and `thinkingActive`. The disclosure opens and animates only while thinking is active. `message_end` commits ordered thinking, text, and tool-reference blocks atomically. History parsing reconstructs the same blocks from the SDK message or JSONL file, so reasoning survives navigation and reloads.

### Agent completion

A normal `agent_end` clears transient state because canonical events have already committed the turn. An aborted `agent_end` also invalidates history so the browser reconstructs the final state from the server file.

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
- `conversation_reset` installs the new incarnation position, clears transient state, and refetches history.
- Snapshot reconciliation overlays only explicitly pending canonical and optimistic items.
- Reset records prior runtime incarnations as superseded. Late events and snapshots from those incarnations are ignored, while an unknown authoritative incarnation can establish a newer ledger during WebSocket downtime.
- Each history request carries a local generation tag. Reset, rewrite, and replay-gap recovery invalidate older in-flight responses.
- A same-incarnation network response cannot move the accepted sequence backward.
- Once a matching snapshot covers a pending item by canonical ID or watermark, the reducer removes that overlay.

Revalidation occurs after reconnect, replay gaps, runtime-incarnation changes, history rewrites, aborted generation, and persistence-enrichment errors.

When the active route changes, `setupWsRouteSubscriptions()` clears the previous session's transient state before it changes the server subscription. `<StreamsMessageList key={piSessionId}>` remounts the virtualizer and initial-bottom state for the new conversation.

## Render Boundaries

- Text and thinking deltas update only `StreamingAssistantRow`; committed rows and `ChatPanel` do not subscribe.
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
- `web/src/lib/conversation-state.ts` — canonical cache writes, snapshot reconciliation, external-store snapshots, and hooks.
- `web/src/lib/conversation-rows.ts` — direct timeline row derivation and tool pairing.
- `web/src/components/streams-message-list.tsx` — React-owned TanStack Virtual list.
- `web/src/components/chat-message-row.tsx` — committed and transient message rows.
- `web/src/components/chat-tool-message.tsx` — specialized tool cards and localized tool subscriptions.
