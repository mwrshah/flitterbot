# Streaming Markdown Rendering Performance

## Purpose

The chat renders valid Markdown while an assistant response grows. Streaming updates stay smooth, committed rows remain stable, and code highlighting does not run on incomplete fences.

## Architecture

`conversation-state.ts` stores each incomplete assistant block in a `Map` keyed by Pi's `contentIndex`. Each text or thinking delta updates only its indexed block, and each block owns its active lifecycle because blocks can interleave. Only `StreamingAssistantRow` subscribes through `useSyncExternalStore`; `ChatPanel`, the virtual list, and committed rows do not subscribe to content deltas.

The store applies every event immediately but publishes at most one immutable streaming snapshot per animation frame. The first snapshot for a new `messageId` publishes immediately so stale content cannot flash. `MarkdownContent` uses `@tanstack/markdown` with its streaming extension, which keeps incomplete block syntax renderable. The parser receives each grouped content run, while frame-level publication bounds parsing and React reconciliation to the browser paint cadence.

Committed messages use the same `MarkdownContent` component without the streaming extension. Fenced code uses `highlight.js` after commit. During streaming, code fences render escaped plain text and skip syntax highlighting. Copy controls always use the original code string.

## Pseudocode Contracts and Call Graph

```ts
type StreamingBlock = {
  block: ChatTimelineMessageBlock
  tool?: ChatTimelineTool
  active: boolean
}

type StreamingMessage = {
  messageId: string
  blocks: ReadonlyMap<number, StreamingBlock>
}
```

```text
assistant_block_set / assistant_block_delta
  → conversationState.blocks.get(contentIndex)
    → animation-frame snapshot
      → useConversationStreaming(piSessionId)
        → StreamingAssistantRow
          → buildConversationContentParts
            → MarkdownContent(streaming=partHasActiveBlock)

assistant_message_snapshot
  → replace the complete indexed in-flight message after subscription or reset

message_end
  → authoritative ChatTimelineMessage in TanStack Query
  → clear the incomplete snapshot
  → ChatMessageRow uses the same buildConversationContentParts projection
```

## Component Tree

```text
StreamsMessageList
  ├─ ChatMessageRow
  │   └─ AssistantContents
  │       └─ MarkdownContent
  └─ StreamingAssistantRow [only content-delta subscriber]
      └─ AssistantContents
          └─ MarkdownContent(streaming per active indexed run)
```

## Rendering Invariants

- A new `messageId` replaces the previous incomplete message.
- `contentIndex` identifies blocks across text, thinking, and tool-call content; event contiguity is never assumed.
- Content deltas rerender only the incomplete assistant row.
- Empty or encrypted-only thinking blocks produce no disclosure.
- Adjacent readable thinking blocks share one disclosure; nonempty text and tool blocks terminate the run.
- Committed rows consume `ChatTimelineItem` directly and never convert to Pi message types.
- Raw HTML stays escaped.
- Links and images accept only root-relative paths, same-document fragments, and `http`, `https`, `mailto`, or `tel` URLs.
- Same-document links stay in the current tab. External links use `target="_blank"` with `rel="noopener noreferrer"`.
- Footnote IDs are namespaced per Markdown instance so separate messages do not create duplicate document IDs.
- Code highlighting runs only for committed, size-bounded fences with an explicit supported language. Plain-text, unknown, oversized, and streaming code stays escaped text.
- TanStack Virtual measures all Markdown, disclosure, image, and code height changes from the row element.

## Key Files

- `src/streams/pi-subscribe.ts` — indexed Pi block events, tool-call snapshots, and authoritative in-flight snapshot provider.
- `src/ws/hub.ts` — positioned replay followed by the current unpositioned in-flight snapshot.
- `web/src/lib/conversation-state.ts` — sparse-safe indexed block state, frame-bound snapshots, and localized subscriptions.
- `web/src/lib/conversation-rows.ts` — shared grouping for live and committed content.
- `web/src/components/chat-message-row.tsx` — incomplete assistant row and ordered message rendering.
- `web/src/components/common/markdown-content.tsx` — TanStack Markdown configuration, URL policy, streaming extension, and footnote namespace.
- `web/src/components/common/code-block.tsx` — committed highlighting and code copy behavior.
- `web/src/components/streams-message-list.tsx` — measured virtual rows and end anchoring.
