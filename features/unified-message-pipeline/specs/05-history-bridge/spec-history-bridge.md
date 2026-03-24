# Spec 05: History Bridge

**Dependencies:** Spec 02 (server UUIDs and mapping table)

## Problem

The history parser (`src/pi/history.ts`) reads Pi session JSONL files and constructs `PiHistoryItem[]` with IDs derived from agent-generated UUIDs. These IDs use suffix conventions (`:message`, `:message-N`, `:tool-start-N`, `:tool-end`) that the frontend also appends when processing live WS events — a fragile coupling that breaks in several cases (multi-message splits, missing messageIds, random tool IDs).

After specs 02-03, the server assigns UUIDs and WS events carry them. But history is read from session files that contain agent IDs, not server IDs. Without a bridge, historical items and live items will have different IDs and deduplication fails.

## Functional Requirements

### FR-1: Resolve agent IDs to server UUIDs

When parsing a session file, the history parser looks up each agent message ID in the `message_id_map` table (spec 02) to get the corresponding server UUID. If found, use the server UUID as the item's `id`. If not found (legacy records, or messages that predated the mapping table), fall back to the agent ID directly.

The lookup function (`resolveServerId(agentId)`) is provided by the blackboard DB module (spec 02). The history parser needs access to the database — either passed in directly or via a resolver function injected at call time.

### FR-2: Remove suffix conventions

Stop appending `:message`, `:message-N`, `:tool-start-N`, `:tool-end` to item IDs. The server UUID (or agent UUID for legacy) is the item ID directly.

Current behavior in `pushMessage()` (`history.ts:58-59`):
```
id: `${id}:${suffix}`    // e.g., "abc123:message-0"
```

New behavior:
```
id: resolvedServerUuid    // e.g., "def456" (the server UUID)
```

**Multi-message splitting:** When a single agent message produces multiple `PiHistoryMessageItem`s (text split by tool calls), they currently get `message-0`, `message-1`, etc. With unified IDs, these sub-items need stable sub-IDs. Use `"${serverUuid}:${index}"` (e.g., `"def456:0"`, `"def456:1"`). This is only needed when a single agent message splits into multiple display items — the common case (one agent message → one display item) uses the bare UUID.

The WS path (spec 03) handles this naturally: `message_end` fires once per agent message, so there's no splitting on the live path. The split only happens in history parsing where the parser reconstructs from the session file's content blocks.

### FR-3: Deterministic tool item IDs

Tool items currently get IDs like `"agentId:tool-start-0"`. Replace with IDs derived from the tool's `toolCallId` (from the agent session record) and the resolved server UUID:
- Tool start: `"${serverUuid}:tool:${toolCallId}:start"`
- Tool end: `"${serverUuid}:tool:${toolCallId}:end"`

If `toolCallId` is unavailable, fall back to a positional index within the message. This aligns with spec 03's deterministic tool IDs on the WS path, enabling deduplication.

### FR-4: Fallback for unmapped legacy records

Session files created before the mapping table was introduced will have agent IDs with no mapping. The history parser should handle this gracefully:
- Use the agent ID directly as the item ID (no suffix)
- These items won't deduplicate against live WS items (which use server UUIDs), but this is acceptable for pre-migration historical data
- As new messages flow through the system, they'll have mappings and dedup correctly

No backfill migration is needed. Legacy data remains readable; it just won't deduplicate with live events for the same message. In practice, users rarely view historical sessions while simultaneously receiving live events for those same sessions.

### FR-5: History parser receives resolver

The history parser functions (`readPiHistory`, `readPiHistoryFromMessages`) currently take `(sessionId, sessionFile, mode)`. Add an optional `resolver` parameter — a function `(agentId: string) => string | null` that returns the server UUID for a given agent ID, or null if unmapped.

When called from the HTTP history endpoint (`src/routes/browser-pi.ts`), pass a resolver backed by the mapping table. When called from other contexts (e.g., agent prompt building via `readPiHistoryFromMessages`), the resolver can be omitted — those paths don't need dedup-safe IDs since they're not rendering to the frontend.

## Approach

The change is localized to `src/pi/history.ts` and its caller in `src/routes/browser-pi.ts`. The parser's internal `pushMessage()` and `parseMessageRecord()` functions receive the resolver and use it when constructing IDs.

The resolver is a thin wrapper over `SELECT server_id FROM message_id_map WHERE agent_id = ?` — synchronous via `better-sqlite3`'s `.get()`. Performance is fine: one query per message in the session file, and the index on `agent_id` makes it fast.

The `PiHistoryItem` types (`PiHistoryMessageItem`, `PiHistoryToolItem`) in `src/contracts/control-surface-api.ts` don't need type changes — `id` is already `string`. The values just change format (from suffixed agent IDs to bare server UUIDs).

## Files

- `src/pi/history.ts` — accept resolver, resolve IDs, remove suffix conventions, deterministic tool IDs
- `src/routes/browser-pi.ts` — pass resolver backed by mapping table to `readPiHistory()`
- `src/blackboard/db.ts` — expose `createIdResolver(db)` helper that returns the resolver function
