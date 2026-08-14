# Conversation Find

## Problem

Native browser find sees only the rows that TanStack Virtual mounts. Conversation history uses bounded pages, so native `Cmd+F` or `Ctrl+F` cannot find older messages.

## Behavior

- `Cmd+F` and `Ctrl+F` open a conversation-local find bar on stream routes.
- The first non-empty query on a route loads the complete current branch with one `limit=all` request. Opening an empty find bar leaves the rendered timeline unchanged.
- Normal history retains 30-row initial loading and 10-row backward pagination.
- Search covers committed user-role content, including visible compaction summaries, and committed assistant text blocks.
- Assistant text uses raw Markdown source. Tools and thinking blocks are excluded.
- Streaming text becomes searchable after it commits.
- Search is case-insensitive and counts non-overlapping occurrences.
- The bar shows the selected occurrence and total, such as `12/30`.
- During rapid typing, the previous count, selected occurrence, and row marker remain visible until the deferred search commits the new results together.
- Enter and Arrow Down select the next occurrence. Shift+Enter and Arrow Up select the previous occurrence. Navigation wraps.
- The virtualizer mounts and centers the selected row.
- The whole selected row receives a background and border marker. Individual text is not highlighted.
- Escape closes find. IME composition, dialogs, menus, context menus, and inline command pickers retain their keyboard behavior.

## History Caches

The normal infinite-query cache remains the authoritative bounded history:

```text
["streams-history", sessionId, "agent"]
```

Find uses a disposable complete snapshot under a separate query key:

```text
["streams-history", sessionId, "agent", "find"]
```

The temporary query requests `limit=all` and stores one chronological response. It never changes the normal cache's pagination shape or page parameters. Complete-history failures therefore cannot corrupt or place the normal route query into an error state.

After the complete snapshot loads, the route continues to render it even when the find bar closes. This preserves every row after an old match, so the user can scroll naturally back to the newest message without forward-pagination support. Current bounded items replace snapshot items with the same IDs, and new bounded items append to the route timeline.

The complete snapshot remains for the stream route's lifetime. Its query uses `gcTime: 0`, so TanStack Query purges it when the route stops observing that session. Reopening find on the same route reuses the snapshot without another request. The memory tradeoff is limited to routes where find was used: transcript data remains in JavaScript memory, while TanStack Virtual still bounds mounted DOM rows.

A prune or branch rewrite starts a temporary-query reset before refreshing normal history. Resetting immediately removes the stale complete snapshot. The auxiliary complete refetch runs independently, so it never delays the bounded-history resume position or WebSocket resubscription. While it reloads, the route renders bounded history. TanStack Query cancels superseded complete requests through the request `AbortSignal`.

## Components

`ChatPanel` owns the find bar, query, selected occurrence, and temporary-query lifecycle. It merges the complete snapshot with current bounded items, builds canonical conversation rows, and searches committed source text. Results store one count per matching row and a cumulative first-match index.

`StreamsMessageList` receives whether the bar is open and the selected row index. Its find responsibilities are limited to:

1. Reserve top space for the find overlay.
2. Keep the selected row mounted through `rangeExtractor`.
3. Call `scrollToIndex(rowIndex, { align: "center" })`.
4. Apply the selected-row visual marker.

TanStack Virtual remains enabled. No Markdown projection, DOM text walker, offset mapper, CSS Custom Highlight integration, streaming-search state, complete-mode mutation of the normal cache, or custom complete-load coordinator exists.

## Failure States

- The bar shows `Loading…` while complete history loads.
- A failed complete request leaves normal history intact and exposes Retry.
- An empty query shows no results.
- A query with no matches shows `0/0`.
- A failed refetch after a rewrite leaves the route on bounded history.

## Key Files

- `src/contracts/control-surface-api.ts` — numeric-or-`all` history limit contract.
- `src/streams/history.ts` — complete-history limit parsing and projection.
- `web/src/lib/queries.ts` — bounded and disposable complete query definitions.
- `web/src/lib/conversation-history.ts` — normal-history updates and complete-query reset after rewrites.
- `web/src/lib/conversation-find.ts` — timeline merge, committed source-text counting, and wrapped row selection.
- `web/src/components/chat-panel.tsx` — find state, toolbar, search query, and route-lifetime complete timeline.
- `web/src/components/streams-message-list.tsx` — selected-row mounting, centering, and marker.
- `src/history-pagination.test.ts` — complete-history server contract.
- `web/tests/conversation-find.test.ts` — source-text matching and navigation primitive.
