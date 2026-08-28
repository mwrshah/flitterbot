# User Message Markers

## Problem

Conversation history is paginated, while the marker rail represents every user-message row in the active Pi-session history. Loaded pages cannot supply a complete marker set or identify an unloaded target, and loading full message bodies solely to draw the rail defeats pagination.

## Contract

```ts
interface StreamsHistoryResponse {
  items: ChatTimelineItem[]
  userMessageIndex?: string[]
  historyPosition?: ConversationEventPosition
  turnQueue?: TurnQueueSnapshot
  olderPageCursor?: string | null
}
```

The initial paginated history response for one Pi session includes `userMessageIndex`. It contains the stable ID of every shaped `role: "user"` row in chronological order, including hook messages and compaction summaries that render as user rows. Array position is the message ordinal. Older cursor pages, `limit=all` conversation-find responses, and the aggregate input surface omit the index.

## Server Flow

The history materializer shapes the complete active branch and builds the ID index before page slicing. The history route attaches that complete index only to an initial paginated session request.

```text
initial session history
  → shape complete branch
  → collect every user-message ID
  → slice newest visible-row page
  → return page + complete index
```

Full message bodies, assistant responses, tools, and images remain paginated. Live `message_end` events use the existing committed timeline items; they do not carry a second marker-specific payload or reread complete history.

## Client Flow

TanStack Infinite Query stores pages oldest to newest, so the newest page owns the canonical index. A live user item appends its ID when absent. A replay does not duplicate it, and replacing a user item with another role removes its ID. A history rewrite replaces the index from the next authoritative initial snapshot.

Every history invalidation or recovery uses one refresh primitive. It preserves the current infinite data, discards cached cursor pages, restores the initial `undefined` page parameter, refetches the newest page, and replaces the index from the server snapshot. If the refetch fails, it restores the prior pages, invalidates the query without another request, and rethrows. The client never reconstructs the complete index from loaded pages.

`StreamsMessageList` owns navigation because it owns the loaded conversation rows, scroll element, and virtualizer. Selecting a marker records its message ID. While that selection exists, initial-fill and scroll-threshold loading stop, and one marker effect owns older-page requests. Each committed page either exposes the target or triggers the next sequential cursor request. A later selection replaces the earlier target.

A failed cursor request leaves the scroll position unchanged and marks the selected control as a retry. Selecting it again clears the error and resumes pagination. If the authoritative index no longer contains the target, navigation stops.

When the target row commits, a layout effect resolves its message ID to the current `ConversationRow` index and calls:

```ts
virtualizer.scrollToIndex(rowIndex, { align: "start", behavior: "auto" })
```

A viewport-sized virtualizer tail remains while marker navigation is active and has not failed, allowing even the latest user row to reach the viewport's top edge. The virtualizer disables `followOnAppend` only while that reserve exists. `scrollToEnd` removes the reserve before pinning to the end.

`Shift+G` selects the final ID in `userMessageIndex`, so keyboard and pointer navigation share the same pagination, retry, and alignment path. The handler runs only when the main conversation feed is the resolved shortcut target; a visible Diff scroller keeps priority.

## Marker Rail

The message list is a two-column grid: a `minmax(0, 1fr)` scroll viewport, a `0.5rem` gap, and a `1.75rem` marker rail. The viewport owns its native scrollbar and stable scrollbar gutter, so the rail always begins after both. Each ID renders one fixed-height button row. A right-aligned CSS dash sits inside the fixed-width rail, so every width transition preserves the same right endpoint.

The rail renders at most 25 controls: the active marker plus up to 12 IDs on either side. It centers a newly selected navigation target, then follows the loaded user row whose top edge is nearest the viewport's top edge. At the beginning or end of history it shows only the available IDs within that 12-marker radius. If the viewport is too short for the window, the rail clips fixed-height rows and keeps its center marker visible instead of compressing controls. The active viewport marker uses the main text color and `aria-current`; a failed navigation target remains red.

CSS sibling selectors create the asymmetric hover and `focus-visible` rhythm. The focused dash expands from `0.5rem` to `1.5rem`. Its three preceding dashes expand to `0.625rem`, `0.75rem`, and `1rem`; its three following dashes expand to `0.875rem`, `0.6875rem`, and `0.5625rem`. Reduced-motion preferences disable the transition.

## Invariants

- `userMessageIndex.length` is the complete marker count.
- Index order is chronological, and marker identity comes from stable message IDs.
- Loaded cursor pages remain a contiguous suffix of the complete timeline.
- Cursor requests are sequential and never request full assistant or tool history solely for marker navigation.
- Start alignment runs only after the target row commits.
- A failed marker remains an explicit retry control.
- Dense rails render no more than 12 markers on either side of the current marker.
- The loaded user row nearest the viewport top is exposed visually and through `aria-current`.
- Hover and keyboard focus use the same CSS-only geometry.
