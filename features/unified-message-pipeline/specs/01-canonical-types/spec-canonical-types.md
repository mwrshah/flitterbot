# Spec 01: Canonical Types

**Dependencies:** None — this is the shared contract everything else builds on.

## Problem

Messages have 5 different type representations. Backend `UnifiedMessageSource` has 7 values; frontend `MessageSource` has 5, silently accepting invalid values via unchecked casts. Historical messages carry `blocks` (text + thinking); live WS messages carry flat `content`. There is no single type that works across persistence, transport, and rendering.

## Functional Requirements

### FR-1: Unified message type

Define a single `UnifiedMessage` interface in `src/contracts/` that represents a message at every layer. All fields that vary by layer (streaming, persistence metadata) are optional. The type must be importable by both backend and frontend code.

```ts
type MessageSource = "whatsapp" | "web" | "hook" | "cron" | "init" | "agent" | "pi_outbound";

type MessageBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string };

interface UnifiedMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  blocks?: MessageBlock[];
  images?: Array<{ data: string; mimeType: string }>;
  source: MessageSource;
  workstreamId?: string;
  workstreamName?: string;
  createdAt: string;
  intermediate?: boolean;
  textDelta?: string;
  metadata?: Record<string, unknown>;
}
```

Key decisions:
- `id` is `string` (UUID), required, never optional. Server assigns it (spec 02).
- `content` is always the plain-text representation. `blocks` carries structured content when available (thinking blocks, multi-part text). Both may be present — `content` is the display fallback.
- `textDelta` is only present during streaming. When a message completes, `textDelta` is dropped and `content` is set to the final text.
- `source` uses the full 7-value union — no separate backend/frontend types.
- `intermediate` marks pre-tool-call fragments within a turn (only the final assistant message per turn omits this flag).

### FR-2: Align MessageSource across layers

Replace the frontend's 5-value `MessageSource` with the shared 7-value `MessageSource`. Update all frontend files that reference the old type.

The frontend already handles source-based rendering (badges, colors, labels in `input-surface.tsx`). Add display entries for `"agent"` and `"pi_outbound"` — these won't appear in user-facing surfaces under normal operation, but the type must be sound.

### FR-3: MessageBlock as shared type

`MessageBlock` replaces the inline `blocks` array type currently duplicated across `PiHistoryMessageItem`, `ChatTimelineMessage`, and the pi-web-ui bridge. One definition, imported everywhere.

### FR-4: Backward compatibility of ChatTimelineItem

`ChatTimelineItem` (the frontend union of message/tool/divider) remains the rendering type — it's the right abstraction for the timeline UI. `ChatTimelineMessage` should extend or align with `UnifiedMessage` so that no mapping is needed for message items. Tool and divider items keep their current shapes (they aren't "messages" and don't need unification).

## Approach

Define `UnifiedMessage`, `MessageSource`, and `MessageBlock` in a new shared contract file (`src/contracts/message.ts`) and re-export from `src/contracts/index.ts`. Update `ChatTimelineMessage` in the frontend to use the shared `MessageSource` type. The frontend can import from the shared contracts via the existing import path.

Existing types (`MessageRow`, `PiHistoryMessageItem`, `MessageEndWebSocketEvent`) are not deleted in this spec — they get migrated in subsequent specs as their layers adopt the unified type. This spec establishes the target; specs 02-05 converge on it.

## Files

- `src/contracts/message.ts` (new) — `UnifiedMessage`, `MessageSource`, `MessageBlock`
- `src/contracts/index.ts` — re-export
- `web/src/lib/types.ts` — import shared `MessageSource`, update `ChatTimelineMessage`
- `web/src/components/input-surface.tsx` — add display entries for `"agent"`, `"pi_outbound"`
