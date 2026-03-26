# Message Struct Unification

## Problem

Two divergent pipelines (WS live vs history API) build `ChatTimelineItem[]` through different shapes, different ID conventions, and manual frontend reconstruction. The WS path emits flat event objects (`message_end` with top-level fields); the frontend manually constructs `ChatTimelineMessage` from these fields. The history path returns pre-shaped `ChatTimelineItem[]` directly.

This creates:
- **Fragile dedup** — backend emits `msg-5`, frontend appends `:message` suffix, history parser creates `:message-0` — mismatch causes silent dedup failure
- **Duplicated construction logic** — `pi.route.tsx` manually builds `ChatTimelineMessage` from flat WS event fields, duplicating what `history.ts` does server-side
- **Cognitive overhead** — two shapes for the same logical concept, two ID conventions, two timestamp field names (`timestamp` vs `createdAt`)

## Goals

1. **Single canonical struct** — `ChatTimelineMessage` used in both WS emission and history API responses
2. **Backend constructs the full item** — `subscribe.ts` builds `ChatTimelineMessage` at `message_end` time and embeds it in the WS event
3. **Lean streaming** — `text_delta` stays minimal (messageId + delta); frontend creates streaming placeholder, `message_end` replaces it
4. **Unified ID scheme** — `msg-{ordinal}` everywhere, no `:suffix` convention, no frontend fallback generation
5. **Net code reduction** — frontend WS handler shrinks from manual construction to push/replace

## Non-Goals

- Unifying the blackboard `messages` table with session history (separate concern: audit/routing vs chat display)
- Modifying the Pi SDK — all changes are in Autonoma's layer
- Changing the JSONL session file format

## Architecture

### Unified Emission

`subscribe.ts` builds a complete `ChatTimelineMessage` for each message, with `id`, `kind`, `role`, `content`, `source`, `createdAt`, and optional fields (`workstreamId`, `workstreamName`, `intermediate`). The `message_end` WS event embeds this object in a `message` field. The frontend pushes it directly into `appendedItems` — no manual field mapping.

### ID Scheme

Both `subscribe.ts` and `history.ts` maintain deterministic ordinal counters. Format: `msg-{ordinal}`. No suffixes. Tool items use `tool-{toolUseId}-{phase}`. Dividers use `divider-{timestamp}`. The backend always provides IDs — no frontend `createId()` fallback.

### Streaming

`text_delta` carries a required `messageId: string` (same `msg-{ordinal}` format). On first delta, the frontend creates a streaming `ChatTimelineMessage` placeholder with that ID. On `message_end`, the embedded `ChatTimelineMessage` replaces the placeholder by ID match. `turn_end` remains as a safety net to clear stale streaming flags.

## Specs

| # | Spec | Depends On | Effort |
|---|------|-----------|--------|
| 01 | [Backend Emission](specs/01-backend-emission/spec-backend-emission.md) | — | Medium |
| 02 | [Frontend Consumption](specs/02-frontend-consumption/spec-frontend-consumption.md) | 01 | Medium |

Spec 01 changes the backend contracts and emission logic. Spec 02 updates the frontend to consume the new shape. Deploy together (internal API, no external consumers).

## Files Touched

### Must Change
1. `src/contracts/timeline.ts` — Add `workstreamId`, `intermediate` to `ChatTimelineMessage`
2. `src/contracts/websocket.ts` — `MessageEndWebSocketEvent` embeds `message: ChatTimelineMessage`; `TextDeltaWebSocketEvent.messageId` becomes required
3. `src/pi/subscribe.ts` — Build full `ChatTimelineMessage` objects, assign `msg-{ordinal}` IDs
4. `src/pi/history.ts` — Align ID format: drop `:suffix`, use `msg-{ordinal}` consistently
5. `web/src/lib/types.ts` — Update `WsMessage` union for new `message_end` shape
6. `web/src/routes/pi.route.tsx` — Simplify WS handler: push/replace embedded items directly

### Likely Change
7. `web/src/lib/utils.ts` — `mergeTimelines` simplified (no suffix matching)
8. `web/src/lib/pi-web-ui-bridge.ts` — Minor field adjustments
9. `web/src/components/input-surface.tsx` — Field name updates

### Unchanged
10. `web/src/components/chat-panel.tsx` — Already consumes `ChatTimelineItem[]`
11. `web/src/components/pi-message-list.tsx` — Receives `AgentMessage[]`, unaffected
12. `web/src/lib/pi-session-store.ts` — Stores `ChatTimelineItem[]`, no shape change
13. `src/blackboard/` — Out of scope (cross-session persistence)

## Research

See [throwaway/investigation-report.md](throwaway/investigation-report.md) for the full end-to-end pipeline analysis.
