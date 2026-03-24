# Unified Message Pipeline

## Problem

Messages flow through 5 distinct representations across 4 layers — SQLite `MessageRow` (integer IDs), Pi session JSONL (agent UUIDs), WebSocket events (optional `messageId`), frontend `ChatTimelineItem` (suffixed IDs or random fallbacks), and pi-web-ui `AgentMessage` (external library shape). No two layers share an ID system; a message persisted in SQLite cannot be correlated with its Pi session representation.

This causes three categories of bugs:

1. **Deduplication failures.** `mergeTimelines()` deduplicates by `id`, but history produces `"uuid:message-0"` while WebSocket produces `"uuid:message"` — no match, duplicate rendered. When `messageId` is missing from a WS event, the frontend falls back to `createId()` (random), which never matches history. Tool items always get random IDs on the WS path and always duplicate.

2. **Dual state management.** InputSurface maintains its own `appendedItems` via `useState`, separate from `piSessionStore`. Two independent WS subscription handlers, two dedup passes, no shared state with the Pi ChatPanel.

3. **Type divergence.** Backend `UnifiedMessageSource` has 7 values; frontend `MessageSource` has 5 (missing `"agent"`, `"pi_outbound"`). The frontend casts without validation, silently producing invalid values. Historical messages have `blocks` (text + thinking); live WS messages have flat `content` only.

## Goals

1. **Single canonical message struct** that works across SQLite, WebSocket, and frontend rendering. Optional `textDelta` field for streaming — no separate streaming type.

2. **Server-assigned UUIDs** generated at message ingestion, stored in SQLite, passed through to Pi agent context, emitted via WebSocket, and used directly as frontend item IDs. One ID per message, everywhere.

3. **Consistent rendering pipeline.** InputSurface consumes from `piSessionStore` (filtered view) instead of independent state. Single WS subscription per surface. `mergeTimelines()` does exact ID match — no suffix conventions or random fallbacks.

4. **Agent-core ID bridging.** Since pi-agent-core generates its own message IDs, maintain a lightweight mapping (server UUID ↔ agent UUID) so history parsing can resolve agent IDs back to server UUIDs.

## Architecture

```
Message arrives (any source)
  → Server assigns UUID via crypto.randomUUID()
  → persistMessage(db, { id: uuid, ... }) → SQLite (TEXT PK)
  → Forward to Pi with UUID as message context metadata
  → Agent records message with its own ID; mapping table links agent_id → server_uuid
  → subscribeToPiSession() resolves agent ID → server UUID
  → broadcast({ messageId: server_uuid, ... }) via WS (required, non-optional)
  → Frontend: ChatTimelineItem { id: server_uuid, ... }
  → Loader history: resolves agent IDs → server UUIDs via mapping
  → mergeTimelines() deduplicates perfectly — same IDs everywhere
```

Two WS events for Pi responses are preserved (`message_end` for agent view, `pi_surfaced` for external-channel delivery) — they serve different purposes but reference the same server UUID.

## Specs

| # | Spec | Depends On | Summary |
|---|------|------------|---------|
| 01 | [canonical-types](specs/01-canonical-types/spec-canonical-types.md) | — | Define `UnifiedMessage` type and align `MessageSource` across backend/frontend |
| 02 | [server-uuid-and-sqlite](specs/02-server-uuid-and-sqlite/spec-server-uuid-and-sqlite.md) | 01 | Server-assigned UUIDs, SQLite schema migration, UUID mapping table |
| 03 | [websocket-unification](specs/03-websocket-unification/spec-websocket-unification.md) | 01, 02 | Required `messageId` on all WS events, remove suffix conventions |
| 04 | [frontend-store-consolidation](specs/04-frontend-store-consolidation/spec-frontend-store-consolidation.md) | 01, 03 | Single store, consolidated WS handlers, streaming integration |
| 05 | [history-bridge](specs/05-history-bridge/spec-history-bridge.md) | 02 | History parser resolves agent UUIDs → server UUIDs, deterministic tool IDs |

## Files Touched

**Backend — contracts:**
- `src/contracts/blackboard.ts` — `MessageRow.id` type change, `UnifiedMessageSource` alignment
- `src/contracts/websocket.ts` — `messageId` required, `text_delta` gets messageId
- `src/contracts/control-surface-api.ts` — `PiHistoryItem` ID format change

**Backend — persistence:**
- `src/blackboard/write-messages.ts` — accept/generate UUID
- `src/blackboard/query-messages.ts` — UUID-based queries
- `src/blackboard/db.ts` — schema migration, UUID mapping table

**Backend — Pi agent:**
- `src/pi/subscribe.ts` — resolve agent ID → server UUID before broadcast
- `src/pi/history.ts` — resolve agent IDs via mapping, remove suffix conventions
- `src/pi/index.ts` — pass server UUID as metadata when prompting agent

**Backend — ingestion:**
- `src/runtime.ts` — generate UUID at message ingestion, store mapping after agent processes

**Frontend — types:**
- `web/src/lib/types.ts` — align `MessageSource`, remove `ChatTimelineDivider` ID fallbacks

**Frontend — state:**
- `web/src/lib/pi-session-store.ts` — add `streamingMessageId`, expose filtered views
- `web/src/lib/utils.ts` — simplify `mergeTimelines()`, remove `createId()` usage for messages

**Frontend — routes/components:**
- `web/src/routes/pi.route.tsx` — use server UUID directly, remove `:message` suffix
- `web/src/components/input-surface.tsx` — consume `piSessionStore` instead of own state
- `web/src/components/chat-panel.tsx` — streaming transition via `streamingMessageId`
- `web/src/lib/pi-web-ui-bridge.ts` — adapt to new ID format
