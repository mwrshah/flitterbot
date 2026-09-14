# User-message marker previews

## Contract and flow

```ts
type UserMessageIndexEntry = { id: string; content: string };
type StreamsHistoryResponse = {
  userMessageIndex?: UserMessageIndexEntry[];
};
```

The newest paginated history response includes an ordered index of every user message, including messages outside the loaded page. Each entry contains the original ID and a plain-text preview. Content stays at or below 500 UTF-16 code units, includes `…` when truncated, and never splits a surrogate pair. Empty text remains empty; assistant messages and tools have no entries.

```text
Full session timeline
  → buildUserMessageIndex
  → toUserMessageIndexEntry (bounded truncation)
  → newest history page.userMessageIndex
  → useStreamsChat → ChatPanel → StreamsMessageList → UserMessageMarkers
  → Tooltip.content

Live message event
  → upsertNewestHistoryItems
  → shared toUserMessageIndexEntry
  → append new ID / replace changed preview / remove non-user entry
```

## Component tree and behavior

```text
UserMessageMarkers (bounded marker window)
└── Tooltip (preview, or navigation label for empty text)
    └── button (ID-based selection; independent accessible navigation label)
```

Markers render previews directly from the index, not from loaded rows. Hovering an unloaded message requires no history fetch. Navigation still loads pages when needed. Live updates preserve index order and reuse the existing index when the preview is unchanged. Truncation runs on the server for history snapshots and on already-received live messages during cache upsert; tooltip rendering does not scan the full timeline or truncate text.

## Files and verification

- `src/contracts/user-message-index.ts` — shared entry type and bounded preview conversion.
- `src/contracts/{control-surface-api,index}.ts` — response type and type export.
- `src/streams/history.ts` — complete ordered preview index.
- `src/routes/browser-streams.ts` — existing newest-page serialization boundary.
- `web/src/lib/{types,conversation-history,user-message-markers}.ts` — type bridge, live cache updates, and ID-based viewport selection.
- `web/src/hooks/use-streams-chat.ts`, `web/src/components/{chat-panel,streams-message-list}.tsx` — typed index propagation and tooltip content.
- `src/history-pagination.test.ts`, `web/tests/{conversation-history,user-message-markers}.test.ts` — unloaded-history coverage, truncation boundaries, Unicode, empty content, live replacements, stable IDs, and viewport selection.

`pnpm run audit:ts` checks formatting, tests, both TypeScript projects, and dependency analysis. Browser hover behavior is not covered by these contract tests.
