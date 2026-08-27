# User Message Markers

## Problem

Conversation history is paginated, but the message rail represents every user-message row in the complete active Pi-session history. A scalar count can draw the correct number of marks, but it cannot identify a mark, determine whether its message is loaded, or navigate to an unloaded message.

The browser therefore needs a lightweight index of every user message during the first history hydration. Full message bodies, assistant responses, tools, and images remain paginated.

## Goals

- The first history response includes the identity and logical position of every user-message row in the complete shaped timeline.
- Marker state remains complete while conversation pages load and unload.
- Live committed user messages extend the index exactly once.
- Prune, compaction, reset, and recovery replace the index from an authoritative history snapshot.
- Every marker maps to one stable user message rather than an anonymous count slot.
- Selecting a marker loads intervening cursor pages when necessary, then snaps the target row's top edge to the feed's top edge.
- `Shift+G` uses the same navigation path for the latest user message instead of bottom-aligning the transcript.

## Delivery Boundary

The feature has two independently shippable slices:

1. **Marker rail foundation** — the history response exposes `totalUserMessages`, live upserts maintain it, and `StreamsMessageList` renders a fixed non-interactive Lucide dash rail. This is the first delivery.
2. **Indexed marker navigation** — initial hydration exposes the complete user-message index, markers become stable navigation targets, cursor pages load on demand, and `totalUserMessages` is removed in favor of `userMessageIndex.length` as the single source of truth.

## Architecture

The history materializer owns the user-message index because it already holds the complete active branch before pagination. It records lightweight locators after timeline shaping and before page slicing. A locator describes a rendered user-message row; it does not duplicate message content.

The initial request, identified by the absence of `before`, returns the full index with the newest history page. Older cursor responses return only their page items and next cursor. TanStack Infinite Query stores pages oldest to newest, so the newest page remains the owner of the full index while older pages prepend.

The client treats `userMessageIndex` as canonical server state. It never derives the complete index from loaded rows. A committed user `message_end` event carries its locator and appends or replaces it by ID. A history rewrite reloads the newest snapshot and replaces the full index.

The marker rail belongs to `StreamsMessageList` but remains outside its scroll element and virtualizer. Absolute positioning keeps it centered in the feed between the ChatPanel header and MessageInput. It does not move message content or the native scrollbar.

## Pseudocode Contracts and Call Graph

```ts
interface UserMessageLocator {
  messageId: string
  ordinal: number       // zero-based position among user messages
  timelineIndex: number // zero-based position in the complete shaped timeline
}

interface StreamsHistoryResponse {
  items: ChatTimelineItem[]
  userMessageIndex?: UserMessageLocator[] // present when `before` is absent
  historyPosition?: ConversationEventPosition
  turnQueue?: TurnQueueSnapshot
  olderPageCursor?: string | null
}

interface MessageEndWebSocketEvent {
  type: "message_end"
  piSessionId?: string
  items: ChatTimelineItem[]
  userMessageLocator?: UserMessageLocator
}

interface StreamsMessageListProps {
  userMessageIndex: UserMessageLocator[]
}

type MarkerNavigationState =
  | { status: "idle" }
  | { status: "loading"; targetMessageId: string }
  | { status: "aligning"; targetMessageId: string }
```

`timelineIndex` is a logical server position, not a pixel offset. The browser resolves the loaded `ConversationRow` index and TanStack Virtual owns pixel measurement.

Production hydration:

```text
GET /api/streams/history?piSessionId&limit=30
  → read complete active Pi-session branch
    → shape complete timeline
      → collect user-role message locators in chronological order
      → slice newest visible-row page
        → StreamsHistoryResponse { items, userMessageIndex, olderPageCursor }

GET /api/streams/history?piSessionId&before=<opaque cursor>
  → read and shape complete active branch
    → slice page before cursor
      → StreamsHistoryResponse { items, olderPageCursor }
```

Live state:

```text
persisted user message
  → message_end { items, userMessageLocator }
    → upsert newest-page items
    → upsert locator by messageId
      → marker rail appends once

history_rewritten / conversation_reset / recovery
  → refresh newest history snapshot
    → replace userMessageIndex
    → discard stale marker-navigation target
```

Marker navigation:

```text
select marker(locator)
  → target message already present in loaded conversation rows?
    → yes: resolve row index
    → no: repeatedly fetchPreviousPage using olderPageCursor
      → stop when target messageId appears or no older page remains
  → wait for prepended rows to commit to the virtualizer
  → virtualizer.scrollToIndex(rowIndex, { align: "start", behavior: "auto" })
  → target user row top aligns with feed viewport top

Shift+G
  → select final userMessageIndex locator
    → same load-and-align path
```

Tests:

```text
complete mixed timeline
  → initial page hydration
    → index contains every shaped user message in stable chronological order
    → index is independent of page size and cursor depth

message_end replay
  → locator upsert by messageId
    → duplicate/replacement event does not add a marker

marker target outside loaded suffix
  → fetch cursor pages in order
    → target row commits
      → one immediate start-aligned virtualizer scroll
```

## Component Tree

```text
<PiSessionRoute>
└── <ChatPanel userMessageIndex>
    └── <StreamsMessageList userMessageIndex>
        │ State: active marker-navigation target only
        │ Events: selectMarker, fetchPreviousPage, cancel stale target
        │
        ├── scroll viewport [owns scrollRef and virtualizer]
        │   └── virtual conversation rows
        │
        └── <UserMessageMarkers>
            └── marker × UserMessageLocator
```

`useStreamsChat` owns paginated history and the canonical user-message index. `ChatPanel` passes both through without deriving navigation data. `StreamsMessageList` owns target resolution because it owns the scroll element, loaded rows, and virtualizer. `UserMessageMarkers` renders stable locators and emits selection; it does not fetch or scroll directly.

## State and Behavior Invariants

- `userMessageIndex.length` is the marker count and the only complete-count source after the indexed-navigation cutover.
- Locators use stable message IDs as React keys and navigation identities; array indexes are not identities.
- Index order is chronological and ordinals are contiguous from zero.
- Loaded history pages form a contiguous suffix of the complete timeline.
- A marker is loaded when its `messageId` exists in the loaded conversation rows.
- Cursor loading is sequential because `olderPageCursor` is opaque. One active target owns the loading loop; a later selection supersedes it.
- Marker selection never fetches full assistant/tool history in one request and never reconstructs missing cursors on the client.
- Scroll alignment runs after the target row commits. It uses `behavior: "auto"`; no smooth animation delays the snap.
- The scroll range includes enough trailing reserve for the latest user row to align at the top even when little content follows it.
- A failed cursor request preserves the current scroll position and exposes a retry path.
- Interactive markers remain keyboard accessible and provide an ordinal label such as “Go to user message 4 of 12.” Dense layouts preserve one-to-one markers without overlapping ambiguous pointer targets.

## Plan

### Marker rail foundation

- The history page primitive computes `totalUserMessages` before applying its cursor and visible-row limit.
- Every successful history page carries the authoritative scalar total.
- Infinite-query live upserts adjust the total idempotently.
- The message list renders a fixed, non-interactive Lucide marker rail from the total.

### Indexed marker navigation

- The history materializer returns complete user-message locators on initial hydration.
- The WebSocket commit contract carries the locator for a newly committed user message.
- The newest infinite-query page owns and updates `userMessageIndex`.
- Marker rendering cuts over from scalar count slots to stable locator entries and removes `totalUserMessages`.
- Marker selection loads older cursor pages until the target ID is present.
- The virtualizer exposes an immediate start-aligned navigation method with sufficient trailing scroll reserve.
- `Shift+G` selects the latest user-message locator through the same path.

## Files

### Marker rail foundation

- `src/contracts/control-surface-api.ts` — modify: expose the scalar history total.
- `src/streams/history.ts` — modify: count complete shaped user-message rows before pagination.
- `src/routes/browser-streams.ts` — modify: return the total with history pages.
- `src/history-pagination.test.ts` — modify: verify pagination-independent totals.
- `web/src/lib/conversation-history.ts` — modify: maintain the total during live item upserts.
- `web/tests/conversation-history.test.ts` — modify: verify count idempotence.
- `web/src/hooks/use-streams-chat.ts` — modify: expose the newest-page total.
- `web/src/routes/streams.$piSessionId.tsx` — modify: pass marker data into ChatPanel.
- `web/src/components/chat-panel.tsx` — modify: pass marker data into StreamsMessageList.
- `web/src/components/streams-message-list.tsx` — modify: render and position the fixed rail.

### Indexed marker navigation

- `src/contracts/control-surface-api.ts` — modify: replace the scalar total with `UserMessageLocator` and initial `userMessageIndex` contracts.
- `src/contracts/websocket.ts` — modify: carry a committed user-message locator.
- `src/streams/history.ts` — modify: build the complete locator index from the shaped active timeline.
- `src/streams/pi-subscribe.ts` — modify: emit locators after user-message persistence.
- `src/routes/browser-streams.ts` — modify: include the index only on initial hydration.
- `src/history-pagination.test.ts` — modify: verify locator completeness, order, and cursor independence.
- `web/src/lib/conversation-history.ts` — modify: own locator replacement and idempotent live upserts.
- `web/src/lib/ws-query-bridge.ts` — modify: apply committed locators and rewrite resets.
- `web/src/hooks/use-streams-chat.ts` — modify: expose the canonical index and sequential cursor loading.
- `web/src/components/streams-message-list.tsx` — modify: render locator-backed controls and load/align selected targets.
- `web/src/hooks/use-global-shortcuts.ts` — modify: route `Shift+G` through latest-user navigation.
- `web/tests/conversation-history.test.ts` — modify: verify locator cache updates and rewrite replacement.
