# Spec 04: Frontend Store Consolidation

**Dependencies:** Spec 01 (canonical types), Spec 03 (WS unification — required messageId, no suffix)

## Problem

Three frontend issues compound:

1. **Dual state.** InputSurface maintains its own `appendedItems` via `useState`, separate from `piSessionStore`. Two WS subscription handlers run simultaneously with independent dedup passes and no shared state.

2. **Random ID fallbacks.** When `messageId` is missing from a WS event, the frontend generates a random ID via `createId()`. These never match history, causing duplicates. (After spec 03, `messageId` is always present — but the fallback code remains and should be removed.)

3. **Streaming discontinuity.** Streaming text (`text_delta`) accumulates as a flat string in `streamingText` with no associated message ID. When `message_end` arrives, `streamingText` is cleared and a new timeline item appears — causing a visual jump because `PiStreamingMessage` and `PiMessageList` are different components rendering different data.

## Functional Requirements

### FR-1: InputSurface consumes piSessionStore

InputSurface stops maintaining its own `appendedItems` state and WS subscription. Instead, it reads from `piSessionStore` via a filtered view.

The store already accumulates all WS events per session. InputSurface needs a subset: user messages (web/whatsapp only) + assistant messages from `pi_surfaced` events. Add a selector or utility that filters `SessionAccum.appendedItems` to this subset.

InputSurface's `pi_surfaced` handling currently appends to local state. Move this into the shared WS handler in `pi.route.tsx` — the layout route already handles all other event types. `pi_surfaced` should append a `ChatTimelineMessage` (role: "assistant") to the store, tagged so InputSurface can distinguish it from `message_end` assistant messages if needed.

The wildcard subscription (`wsClient.subscribeSession("*")`) that InputSurface currently manages should move to the layout route if not already there.

### FR-2: Remove createId() fallbacks for messages

With spec 03 guaranteeing `messageId` on all message events, remove the `createId()` fallback paths:
- `pi.route.tsx:154` — `message.messageId ? ... : createId("user")`
- `pi.route.tsx:173` — `message.messageId ? ... : createId("assistant")`
- `input-surface.tsx:358` — same pattern for user messages
- `input-surface.tsx:384` — same pattern for pi_surfaced

Replace with direct use: `id = message.messageId`. If `messageId` is somehow absent (defensive), log a warning but still generate an ID — just don't silently swallow the missing data.

Tool events continue to use `createId("tool")` unless spec 03's deterministic tool IDs are available, in which case use `message.id` directly.

### FR-3: Simplify mergeTimelines()

With unified IDs (no suffixes, no random fallbacks), `mergeTimelines()` becomes a straightforward exact-match dedup. The current implementation already does this — the simplification is that the ID invariant is now guaranteed, so edge cases (suffix mismatch, random IDs) no longer occur.

Review and remove any defensive code that existed to handle these edge cases. The function itself likely stays the same; the improvement is in the data flowing through it.

### FR-4: Streaming-to-completed transition

Add `streamingMessageId` to `SessionAccum`:

```ts
type SessionAccum = {
  appendedItems: ChatTimelineItem[];
  streamingMessageId: string | null;
  streamingText: string | null;
  statusPills: StatusPill[];
};
```

When a `text_delta` arrives with a `messageId` (spec 03, FR-2):
- Set `streamingMessageId` to the message ID
- Accumulate text in `streamingText`

When `message_end` arrives for the same message:
- The completed message gets the same ID as `streamingMessageId`
- Clear `streamingText` and `streamingMessageId`

This enables `ChatPanel` to render a smooth transition: the streaming component and the completed item share an ID, so the UI can animate from one state to the other rather than swapping components. The exact rendering strategy (whether to use a single component that handles both states, or cross-fade between two) is an implementation detail — the key requirement is that the same message ID persists across the transition.

### FR-5: Expose filtered store views

Add utility functions for reading the store with filters:

- `getInputSurfaceItems(sessionId)` — returns messages filtered to user (web/whatsapp) + surfaced assistant responses. Used by InputSurface.
- The filter logic currently in `timelineToSurfaceEntries()` (`input-surface.tsx:77-116`) stays in the component — it's a rendering concern. The store just provides the data.

The store should also expose a way to subscribe to all sessions (for InputSurface's wildcard use case) vs a specific session (for ChatPanel). Currently the store is keyed by sessionId — InputSurface needs items across all sessions. Add a `getAllAppendedItems()` or similar accessor that merges items from all sessions, sorted by `createdAt`.

## Approach

The main refactoring is moving InputSurface from self-managed state to store-driven. This is mostly deletion — remove the `useState`, `useEffect` WS subscription, and local dedup logic, replacing with store reads.

The `pi_surfaced` event handler moves to `pi.route.tsx`'s WS subscription block. It should append to the store with a distinguishing marker (e.g., `source: "pi_outbound"` or a `surfaced: true` flag) so InputSurface can identify these items.

The streaming transition is the riskiest change — it touches the rendering pipeline. Implement conservatively: associate the ID but keep the existing two-component rendering initially. Smooth animation can be added as a follow-up.

## Files

- `web/src/lib/pi-session-store.ts` — add `streamingMessageId`, `getAllAppendedItems()`, ensure `pi_surfaced` items are stored
- `web/src/routes/pi.route.tsx` — handle `pi_surfaced` in WS handler, remove `createId()` fallbacks
- `web/src/components/input-surface.tsx` — remove own state/WS subscription, read from store
- `web/src/components/chat-panel.tsx` — pass `streamingMessageId` for transition continuity
- `web/src/lib/utils.ts` — review `mergeTimelines()`, remove defensive edge-case code if any
