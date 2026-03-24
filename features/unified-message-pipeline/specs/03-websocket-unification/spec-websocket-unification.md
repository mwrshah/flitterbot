# Spec 03: WebSocket Unification

**Dependencies:** Spec 01 (canonical types), Spec 02 (server UUIDs and mapping table)

## Problem

`messageId` is optional on `MessageEndWebSocketEvent` and absent from `TextDeltaWebSocketEvent`. When missing, the frontend falls back to `createId()` (random), which never matches history — causing duplicates. The ID emitted is the raw agent UUID, not the server UUID, so even when present it doesn't match the unified ID. Additionally, the frontend appends a `:message` suffix to create the timeline item ID, which must match the history parser's suffix convention to deduplicate — a fragile coupling.

## Functional Requirements

### FR-1: messageId required on message events

`MessageEndWebSocketEvent.messageId` becomes `string` (required, non-optional). `subscribeToPiSession()` resolves the agent's message ID → server UUID via the mapping table (spec 02) before broadcasting. If no mapping exists (edge case: agent ID not yet mapped), the subscriber should insert the mapping at that point — it has both the agent ID and the server UUID from the turn queue metadata.

For user messages: the server UUID was assigned at ingestion and passed to the turn queue. `subscribeToPiSession()` reads it from the current queue item's metadata.

For assistant messages: the subscriber extracts the agent's message ID, resolves it to the server UUID via the mapping table, and uses that as `messageId`.

### FR-2: text_delta gets a messageId

Add `messageId?: string` to `TextDeltaWebSocketEvent`. When the subscriber starts receiving `text_delta` events for a new assistant message, it assigns a server UUID (either pre-allocated or generated at that point) and includes it in every delta. This enables the frontend to associate streaming text with a specific message ID for smooth transition to completed state.

The messageId on text_delta is optional (for backward compatibility during rollout) but the subscriber should always provide it once this spec is implemented.

### FR-3: Remove :message suffix convention

The frontend currently constructs timeline item IDs as `"${messageId}:message"`. With unified server UUIDs, this suffix is unnecessary — the server UUID is the item ID directly.

Remove the suffix from:
- `pi.route.tsx` message_end handler (lines ~154, ~173)
- `input-surface.tsx` message_end and pi_surfaced handlers (lines ~358, ~384)
- Any other frontend code that constructs message IDs

The history parser (spec 05) must also stop adding the `:message` suffix so IDs match.

### FR-4: pi_surfaced uses server UUID

`PiSurfacedWebSocketEvent.messageId` becomes required (non-optional). The runtime resolves the agent's message ID → server UUID before broadcasting `pi_surfaced`. This ensures `pi_surfaced` and `message_end` reference the same server UUID for the same message — critical for deduplication when both events reach different surfaces.

### FR-5: Tool events get deterministic IDs

Add `id: string` to `ToolExecutionStartWebSocketEvent` and `ToolExecutionEndWebSocketEvent`. The subscriber constructs deterministic IDs from the agent's `toolCallId` and the server's session context: `"${serverUuid}:tool-${toolCallId}"` or similar. This replaces the frontend's `createId("tool")` and enables tool event deduplication against history.

If `toolCallId` is unavailable (edge case), fall back to a sequential index within the turn.

## Approach

The core change is in `subscribeToPiSession()` (`src/pi/subscribe.ts`): before broadcasting any event, resolve agent IDs to server UUIDs using the mapping table helpers from spec 02. The mapping lookup is synchronous (SQLite in-process), so it adds negligible latency.

For `text_delta`, pre-allocate a server UUID when the first delta for a new assistant message arrives. Store it in the subscriber's local state (alongside `pendingAssistantMessages`). When `message_end` arrives for that assistant message, use the same UUID. Insert the mapping (server UUID ↔ agent message ID) at `message_end` time when the agent's ID is available.

## Files

- `src/contracts/websocket.ts` — `messageId: string` (required) on `MessageEndWebSocketEvent`, `PiSurfacedWebSocketEvent`; add `messageId?: string` to `TextDeltaWebSocketEvent`; add `id: string` to tool events
- `src/pi/subscribe.ts` — resolve agent IDs → server UUIDs, pre-allocate streaming UUID, deterministic tool IDs
- `src/runtime.ts` — resolve agent ID → server UUID before `pi_surfaced` broadcast
- `web/src/lib/types.ts` — update `WsMessage` union to reflect required `messageId`
