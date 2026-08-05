# Conversation History Pagination

## Problem

A conversation opens without downloading or retaining its complete transcript. Sidebar intent preloading never fetches conversation history.

## Goals

- The first request returns the newest 30 visible user or assistant rows.
- Older rows load in chronological chunks as the reader reaches the top.
- Tool calls and results remain attached to their surrounding message rows.
- Live WebSocket events update only the newest loaded page.
- Leaving a conversation releases its history immediately.
- Prepending history preserves the row currently under the reader.

## Architecture

The control surface shapes the session timeline, enriches tool display values, and slices complete visible-row pages. Cursors identify the first item in the current page and remain opaque to the browser.

The browser owns one TanStack Infinite Query per session. Pages are stored oldest to newest. The UI flattens loaded pages for row derivation, while optimistic sends and WebSocket commits mutate only the newest page. TanStack Virtual anchors stable row keys when an older page prepends.

## Pseudocode Contracts and Call Graph

```ts
interface StreamsHistoryPage {
  items: ChatTimelineItem[]
  olderPageCursor?: string | null
}

interface StreamsHistoryResponse extends StreamsHistoryPage {
  piSessionId: string | null
  sessionFile: string | null
  hasOlderRows?: boolean
  appliedVisibleRowLimit?: number
}
```

Production:

```text
GET /api/streams/history?piSessionId&before&limit
  → read session branch or file
    → shape timeline items
      → enrich tool display values
        → take page ending before cursor
          → StreamsHistoryResponse

Stream route component
  → useInfiniteQuery
    → fetch newest history page
      → flatten loaded pages chronologically
        → ChatPanel
          → StreamsMessageList
            → TanStack Virtual
              → fetchPreviousPage near the top

WebSocket event
  → conversationState
    → mutate newest infinite-query page
      → virtual message rows
```

Tests:

```text
SDK message fixtures
  → history parser and buildConversationRows
    → ordered tool placement, phase pairing, update coalescing, turn-copy, and stable-key assertions

Conversation state fixtures
  → snapshot reconciliation
    → current-incarnation overlays survive stale snapshot responses
```

## Component Tree

```text
<PiSessionRoute>
└── <ChatPanel>
    └── <StreamsMessageList>
        └── visible React message and tool rows
```

`PiSessionRoute` owns route validation. `useStreamsChat` owns infinite server data and previous-page loading. `ChatPanel` owns sending and optimistic writes. `StreamsMessageList` derives rows directly from `ChatTimelineItem[]`; TanStack Virtual owns top detection, measured geometry, end anchoring, and prepend preservation.

## Files

- `src/contracts/control-surface-api.ts` — defines the paginated response contract and limits.
- `src/streams/history.ts` — encodes cursors and slices complete visible-row pages.
- `src/routes/browser-streams.ts` — validates pagination input and serves pages.
- `web/src/server/streams.ts` — sends cursor requests through the existing server function.
- `web/src/lib/conversation-state.ts` — owns infinite-query live writes and snapshot reconciliation.
- `web/src/lib/queries.ts` — defines the infinite history query.
- `web/src/hooks/use-streams-chat.ts` — flattens pages and exposes older-page loading.
- `web/src/lib/conversation-rows.ts` — pairs canonical message and tool items into virtual rows.
- `web/src/components/streams-message-list.tsx` — renders measured React rows and requests older pages near the top.
- `web/src/components/sidebar.tsx` — disables stream-history intent preloading.
- `web/src/lib/ws-query-bridge.ts` — writes live events to the newest page.
- `tests/streams-history-message-order.test.ts` — verifies persisted text/thinking/tool block order.
- `web/tests/conversation-rows.test.ts` — verifies ordered tool rendering, phase pairing, copy ownership, and stable row keys.
- `web/tests/conversation-state.test.ts` — verifies snapshots, subscriptions, and stale-incarnation rejection.
