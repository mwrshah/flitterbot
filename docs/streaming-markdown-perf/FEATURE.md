# Streaming Markdown Rendering Performance

## Purpose

The chat renders valid Markdown while an assistant response grows. Streaming updates stay smooth, committed rows remain stable, and code highlighting does not run on incomplete fences.

## Architecture

`conversation-state.ts` accumulates text and thinking snapshots by `messageId`. Only `StreamingAssistantRow` subscribes to the streaming snapshot with `useSyncExternalStore`; `ChatPanel`, the virtual list, and committed rows do not subscribe to token deltas.

`conversation-state.ts` appends every delta immediately but publishes at most one immutable streaming snapshot per animation frame. The first snapshot for a new `messageId` publishes immediately so stale content cannot flash. `MarkdownContent` uses `@tanstack/markdown` with its streaming extension, which keeps incomplete block syntax renderable. The parser still receives the accumulated message, but frame-level publication bounds parsing and React reconciliation to the browser paint cadence.

Committed messages use the same `MarkdownContent` component without the streaming extension. Fenced code uses `highlight.js` after commit. During streaming, code fences render escaped plain text and skip syntax highlighting. Copy controls always use the original code string.

## Data Flow

```text
text_delta / thinking_delta
  → conversationState immutable per-session snapshot
    → animation-frame streaming snapshot
      → useConversationStreaming(piSessionId)
        → StreamingAssistantRow
          → MarkdownContent(streaming=true)
          → @tanstack/markdown streaming extension

message_end
  → canonical ChatTimelineMessage in TanStack Query
  → conversationState clears the streaming snapshot
  → ChatMessageRow renders committed Markdown and highlighted code
```

## Rendering Invariants

- A new `messageId` replaces the previous streaming accumulation.
- Token deltas rerender only the transient assistant row.
- Committed rows consume `ChatTimelineItem` directly and never convert to Pi message types.
- Raw HTML stays escaped.
- Links and images accept only root-relative paths, same-document fragments, and `http`, `https`, `mailto`, or `tel` URLs.
- Same-document links stay in the current tab. External links use `target="_blank"` with `rel="noopener noreferrer"`.
- Footnote IDs are namespaced per Markdown instance so separate messages do not create duplicate document IDs.
- Code highlighting runs only for committed, size-bounded fences with an explicit supported language. Plain-text, unknown, oversized, and streaming code stays escaped text.
- TanStack Virtual measures all Markdown, disclosure, image, and code height changes from the row element.

## Key Files

- `web/src/lib/conversation-state.ts` — immutable streaming snapshots and localized subscriptions.
- `web/src/components/chat-message-row.tsx` — transient assistant row and ordered message rendering.
- `web/src/components/common/markdown-content.tsx` — TanStack Markdown configuration, URL policy, streaming extension, and footnote namespace.
- `web/src/components/common/code-block.tsx` — committed highlighting and code copy behavior.
- `web/src/components/streams-message-list.tsx` — measured virtual rows and end anchoring.
- `web/tests/chat-rendering.test.tsx` — server-rendered mixed-block, Markdown safety, footnote, code, and active-tool contracts.
- `web/tests/conversation-state.test.ts` — publication cadence, keyed subscriptions, and snapshot ordering.
