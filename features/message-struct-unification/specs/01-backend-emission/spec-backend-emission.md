# Spec 01: Backend Emission

Restructure backend message emission so that `message_end` WS events carry a complete `ChatTimelineMessage` object, and `history.ts` uses the same ID scheme. After this spec, both the WS live path and the history API produce identically-shaped `ChatTimelineItem[]`.

## Functional Requirements

### FR1: Extend ChatTimelineMessage (`src/contracts/timeline.ts`)

Add two optional fields to `ChatTimelineMessage`:
- `workstreamId?: string` — the workstream this message belongs to (currently only on WS events, not on the canonical type)
- `intermediate?: boolean` — `true` for non-final assistant messages in a multi-message turn

These fields already exist on `MessageEndWebSocketEvent` as flat fields. Moving them into the canonical type ensures the WS-emitted object and the history-loaded object share the same shape.

### FR2: Embed ChatTimelineMessage in MessageEndWebSocketEvent (`src/contracts/websocket.ts`)

Replace the flat fields on `MessageEndWebSocketEvent` with a single `message` field containing the full `ChatTimelineMessage`:

```typescript
export interface MessageEndWebSocketEvent {
  type: "message_end";
  sessionId?: string;
  message: ChatTimelineMessage;
}
```

Remove the individual `messageId`, `role`, `content`, `source`, `timestamp`, `intermediate`, `workstreamId`, `workstreamName` fields. All that information lives inside `message`.

### FR3: Build ChatTimelineMessage in subscribe.ts (`src/pi/subscribe.ts`)

At `message_end` time, `subscribe.ts` currently constructs a flat payload with individual fields. Change it to build a `ChatTimelineMessage` object:
- `id`: `msg-{ordinal}` — the pre-assigned ordinal, no suffix
- `kind`: `"message"`
- `role`: from the SDK event
- `content`: from the SDK event
- `source`: from the current queue item
- `workstreamId`, `workstreamName`: from the current queue item
- `createdAt`: from timestamp extraction (currently emitted as `timestamp`)
- `intermediate`: set during turn_end flush (all but last assistant message)

The ordinal counter logic stays the same: initialized at `session.messages.length`, incremented per message_end for all roles. The only change is the output shape.

For deferred assistant messages (`pendingAssistantMessages`), store the full `ChatTimelineMessage`. At turn_end, set `intermediate: true` on all but the last before broadcasting.

### FR4: Align history.ts ID format (`src/pi/history.ts`)

Currently, `history.ts` generates IDs with suffixes: `msg-{N}:message`, `msg-{N}:message-0`, `msg-{N}:tool-start-0`, `msg-{N}:tool-end`. Change to:
- **Message items**: `msg-{ordinal}` — no suffix
- **Tool items**: `tool-{toolUseId}-start` / `tool-{toolUseId}-end` — keyed by toolUseId and phase, not by message ordinal
- **Divider items**: `divider-{timestamp}`

This makes history IDs match the WS emission IDs exactly, so `mergeTimelines()` deduplication works reliably.

The ordinal counting logic is unchanged — both `subscribe.ts` and `history.ts` count deterministically from session start.

### FR5: Make text_delta messageId required (`src/contracts/websocket.ts`)

Change `TextDeltaWebSocketEvent.messageId` from `string | undefined` to `string`. The backend already assigns this on `message_start` (subscribe.ts:164) — this just tightens the contract to match reality and lets the frontend rely on it unconditionally.

## Verification

- History API returns items with `msg-{ordinal}` IDs (no suffixes)
- WS `message_end` events contain a `message` field with the full `ChatTimelineMessage`
- WS `text_delta` events always carry `messageId`
- For any given session, the Nth message has ID `msg-N` whether loaded from history or received live
