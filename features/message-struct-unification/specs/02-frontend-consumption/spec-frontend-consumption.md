# Spec 02: Frontend Consumption

Update the frontend to consume the new `message_end` shape (embedded `ChatTimelineMessage`) and the unified ID scheme (`msg-{ordinal}`, no suffixes). This is primarily a simplification — replacing manual construction with direct use of backend-provided objects.

Depends on: Spec 01 (backend emission changes).

## Functional Requirements

### FR1: Update WsMessage union (`web/src/lib/types.ts`)

Update the `message_end` variant to match the new backend shape:
- Replace the flat fields (`messageId`, `role`, `content`, `source`, `timestamp`, `intermediate`, `workstreamId`, `workstreamName`) with `message: ChatTimelineMessage`
- Keep `sessionId` at the event level (routing concern, not message data)

Update the `text_delta` variant: `messageId` becomes required (`string`, not `string | undefined`).

Ensure `ChatTimelineMessage` is imported from the shared contracts (already re-exported via `types.ts` from `src/contracts/timeline.ts`).

### FR2: Simplify pi.route.tsx WS handler (`web/src/routes/pi.route.tsx`)

**`message_end` handler** — currently ~60 lines of manual `ChatTimelineMessage` construction. Replace with:
- Extract `message` from the event
- Push it directly into `appendedItems` (new message) or replace the existing streaming placeholder by ID match (finalize streaming)
- The ID is `msg-{ordinal}` — no `:message` suffix appended by the frontend

**`text_delta` handler** — currently creates a streaming item with ID `"{messageId}:message"`. Change to:
- Use `messageId` directly as the item ID (it's now `msg-{ordinal}`, required)
- Create a `ChatTimelineMessage` placeholder: `{ id: messageId, kind: "message", role: "assistant", content: delta, streaming: true, createdAt: now }`
- Subsequent deltas append to content by matching `messageId`

**`message_end` replacing streaming placeholder** — find the existing item by `message.id` (same `msg-{ordinal}`), replace it entirely with the received `ChatTimelineMessage`. This clears `streaming` because the backend-provided object doesn't have it set.

**Remove `createId()` fallback** — the backend always provides IDs. If `message.id` is somehow missing, that's a bug to surface, not a case to paper over with random IDs.

### FR3: Simplify streaming placeholder IDs

Currently the frontend appends `:message` to backend-provided `messageId` to create item IDs like `msg-5:message`. With the unified ID scheme, the item ID is just `msg-5` — matching both the `text_delta.messageId` and the `message_end` embedded item's `id`.

This means:
- No suffix appending in `text_delta` handler
- No suffix appending in `message_end` handler
- `mergeTimelines()` dedup works by direct ID match — a history item `msg-5` and a WS item `msg-5` are the same item

### FR4: Update mergeTimelines (`web/src/lib/utils.ts`)

`mergeTimelines` already deduplicates by ID. With unified IDs the logic doesn't change, but verify it handles the case where a streaming placeholder (`msg-5` with `streaming: true`) should be superseded by a history item (`msg-5` without `streaming`). Currently `mergeTimelines` keeps loader items and filters appended duplicates — this naturally prefers the history (finalized) version. No logic change expected, but confirm the behavior.

### FR5: Adjust pi-web-ui-bridge.ts (`web/src/lib/pi-web-ui-bridge.ts`)

`timelineToAgentMessages()` consumes `ChatTimelineItem[]`. If any field names changed in the canonical type (they shouldn't, but verify):
- `createdAt` is used for timestamp conversion — unchanged
- `source` is used for user message badges — unchanged
- `blocks` parsing for thinking/text — unchanged

The new `workstreamId` and `intermediate` fields on `ChatTimelineMessage` are not consumed by the bridge (display-irrelevant) — no change needed unless the bridge filters by `intermediate`.

### FR6: Adjust input-surface.tsx (`web/src/components/input-surface.tsx`)

Input surface filters timeline items to show only user and final assistant messages. If it currently checks for `intermediate` on the WS event shape (it shouldn't — this field was WS-only), it may need to check `item.intermediate` on the `ChatTimelineMessage` instead. Verify and adjust if needed.

## Verification

- WS messages appear in the timeline with `msg-{ordinal}` IDs (no `:message` suffix)
- Streaming works: first delta creates placeholder, subsequent deltas append, `message_end` replaces with final
- Page reload loads history — same messages, same IDs, no duplicates
- Messages from non-web sources (WhatsApp, hook, cron) display correct source badges
- Multi-message assistant turns: intermediate messages display, final message displays
- `turn_end` safety net still clears any stale streaming flags
