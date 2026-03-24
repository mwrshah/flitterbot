# Spec 02: Server UUID and SQLite

**Dependencies:** Spec 01 (canonical types)

## Problem

SQLite `messages` uses auto-increment integer IDs. Pi agent-core generates its own UUIDs. No mapping exists between them — a business message stored in SQLite cannot be traced to its full agent reasoning in the session file. The frontend never sees SQLite IDs, working exclusively with agent UUIDs via the history endpoint.

## Functional Requirements

### FR-1: Server-assigned UUID at ingestion

Every message entering the system gets a UUID via `crypto.randomUUID()` at the earliest ingestion point — before SQLite persistence and before forwarding to the Pi agent. This UUID becomes the message's identity across all layers.

Generation happens in the message ingestion path (`src/runtime.ts` or the route handler that calls `persistInboundMessage()`). The UUID is passed to both the SQLite insert and the Pi agent turn queue as metadata.

### FR-2: SQLite schema migration

Change `messages.id` from `INTEGER PRIMARY KEY AUTOINCREMENT` to `TEXT PRIMARY KEY`. The server UUID is stored directly as the primary key.

Migration approach:
- Bump `BLACKBOARD_SCHEMA_VERSION`
- Add a migration function that renames the old table, creates the new schema, copies data (casting old integer IDs to text), and drops the old table
- Existing integer IDs become string representations (`"1"`, `"2"`, ...) — harmless since nothing correlates with them

Update `InsertMessageInput` to accept an `id: string` field. `insertMessage()` uses the provided ID instead of relying on `lastInsertRowid`. The return type `MessageRow` changes `id` from `number` to `string`.

### FR-3: UUID mapping table

Since pi-agent-core generates its own message IDs that we cannot override, maintain a mapping table:

```sql
CREATE TABLE IF NOT EXISTS message_id_map (
    server_id TEXT PRIMARY KEY,
    agent_id TEXT,
    pi_session_id TEXT,
    created_at DATETIME NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_message_id_map_agent ON message_id_map(agent_id);
```

Population flow:
1. Server generates UUID, persists message to SQLite with that UUID
2. Server passes UUID as metadata in the turn queue item
3. After the Pi agent processes the message and emits `message_end`, `subscribeToPiSession()` extracts the agent's message ID
4. Insert mapping: `(server_id: our_uuid, agent_id: agent_message_id, pi_session_id)`

This mapping is used by the history parser (spec 05) and the WS subscriber (spec 03) to resolve agent IDs → server UUIDs.

### FR-4: Update write and query paths

- `persistInboundMessage()` and `persistOutboundMessage()` accept an optional `id` parameter. If not provided, generate one.
- `insertMessage()` uses explicit ID in the INSERT statement rather than relying on auto-increment.
- Query functions (`getRecentMessages`, `getMessagesBySource`, `getMessagesByWorkstream`) return `MessageRow` with `id: string`. No query logic changes needed — SQL works the same with TEXT PKs.
- `getRecentConversationByWorkstream()` and `ConversationSnippet` are unaffected (they don't use `messages.id`).

### FR-5: Outbound message ID tracking

When the runtime surfaces a Pi response (`persistOutboundMessage`), it should use the same server UUID that was assigned when the original agent response was mapped. The `pi_surfaced` broadcast already carries `messageId` — this should be the server UUID resolved from the agent's message ID via the mapping table.

## Approach

The migration is straightforward — SQLite handles TEXT PKs natively. The mapping table adds one INSERT per message turn but enables the entire unification. The mapping write happens in `subscribeToPiSession()` (or a callback from it) since that's where we first learn the agent's message ID for a given turn.

The key constraint: mapping population is asynchronous (we learn the agent ID only after the agent processes the message). Between ingestion and agent processing, only the server UUID exists. This is fine — the frontend doesn't need the agent ID; it needs the server UUID. The mapping is only consumed by the history parser (which reads after the fact) and the WS subscriber (which has both IDs available at the same time).

## Files

- `src/contracts/blackboard.ts` — `MessageRow.id: string`, mapping table schema, bump version
- `src/blackboard/write-messages.ts` — `InsertMessageInput.id: string`, explicit ID in INSERT
- `src/blackboard/query-messages.ts` — update return types
- `src/blackboard/db.ts` — migration function, mapping table helpers (`insertIdMapping`, `resolveServerId`)
- `src/runtime.ts` — generate UUID at ingestion, pass as turn queue metadata
- `src/pi/subscribe.ts` — insert mapping after extracting agent message ID
