import type { MessageMetadata, MessageRow, UnifiedMessageSource } from "../contracts/index.ts";
import type { BlackboardDatabase } from "./db.ts";
import { type InsertMessageInput, insertMessage as writeMessage } from "./write-messages.ts";

export function insertMessage(db: BlackboardDatabase, input: InsertMessageInput): MessageRow {
  return writeMessage(db, input);
}

export function persistInboundMessage(
  db: BlackboardDatabase,
  opts: {
    id?: string;
    source: UnifiedMessageSource;
    content: string;
    sender?: string;
    workstreamId?: string;
    metadata?: MessageMetadata;
  },
): MessageRow {
  return writeMessage(db, {
    id: opts.id,
    source: opts.source,
    direction: "inbound",
    content: opts.content,
    sender: opts.sender,
    workstreamId: opts.workstreamId,
    metadata: opts.metadata,
  });
}

export function persistOutboundMessage(
  db: BlackboardDatabase,
  opts: {
    id?: string;
    source: UnifiedMessageSource;
    content: string;
    workstreamId?: string;
    metadata?: MessageMetadata;
  },
): MessageRow {
  return writeMessage(db, {
    id: opts.id,
    source: opts.source,
    direction: "outbound",
    content: opts.content,
    sender: "pi",
    workstreamId: opts.workstreamId,
    metadata: opts.metadata,
  });
}

export function getRecentMessages(db: BlackboardDatabase, limit: number = 50): MessageRow[] {
  return db.all<MessageRow>("SELECT * FROM messages ORDER BY created_at DESC LIMIT ?", limit);
}

export function getMessagesBySource(
  db: BlackboardDatabase,
  source: UnifiedMessageSource,
  limit: number = 50,
): MessageRow[] {
  return db.all<MessageRow>(
    "SELECT * FROM messages WHERE source = ? ORDER BY created_at DESC LIMIT ?",
    source,
    limit,
  );
}

export function getMessagesByWorkstream(
  db: BlackboardDatabase,
  workstreamId: string,
  limit: number = 100,
): MessageRow[] {
  return db.all<MessageRow>(
    "SELECT * FROM messages WHERE workstream_id = ? ORDER BY created_at ASC LIMIT ?",
    workstreamId,
    limit,
  );
}

export type ConversationSnippet = {
  workstream_id: string;
  workstream_name: string;
  content: string;
  source: string;
  created_at: string;
  direction: "inbound" | "outbound";
  sender: string | null;
};

export function getRecentDefaultMessages(
  db: BlackboardDatabase,
  limit: number = 10,
): Pick<MessageRow, "content" | "created_at">[] {
  const rows = db.all<Pick<MessageRow, "content" | "created_at">>(
    `SELECT content, created_at FROM messages
     WHERE direction = 'inbound' AND workstream_id IS NULL
     ORDER BY created_at DESC LIMIT ?`,
    limit,
  );
  // Return in chronological order
  return rows.reverse();
}

export type DefaultConversationSnippet = {
  content: string;
  source: string;
  created_at: string;
  direction: "inbound" | "outbound";
  sender: string | null;
};

export function getRecentDefaultConversation(
  db: BlackboardDatabase,
  limit: number = 10,
): DefaultConversationSnippet[] {
  const rows = db.all<DefaultConversationSnippet>(
    `SELECT content, source, created_at, direction, sender
     FROM messages
     WHERE workstream_id IS NULL
       AND created_at >= COALESCE(
         (SELECT started_at FROM pi_sessions
          WHERE role = 'default' AND status NOT IN ('ended', 'crashed')
          ORDER BY started_at DESC LIMIT 1),
         datetime('now', '-1 hour')
       )
     ORDER BY created_at DESC LIMIT ?`,
    limit,
  );
  return rows.reverse();
}

export function getRecentConversationByWorkstream(
  db: BlackboardDatabase,
  withinHours: number,
  maxPerWorkstream: number,
): Map<string, ConversationSnippet[]> {
  const rows = db.all<ConversationSnippet>(
    `SELECT m.workstream_id, w.name AS workstream_name,
            m.content, m.source, m.created_at, m.direction, m.sender
     FROM messages m
     JOIN workstreams w ON w.id = m.workstream_id AND w.status = 'open'
     WHERE m.created_at >= datetime('now', '-' || ? || ' hours')
     ORDER BY m.workstream_id, m.created_at DESC`,
    withinHours,
  );

  const grouped = new Map<string, ConversationSnippet[]>();
  for (const row of rows) {
    const list = grouped.get(row.workstream_id) ?? [];
    if (list.length < maxPerWorkstream) {
      list.push(row);
    }
    grouped.set(row.workstream_id, list);
  }
  return grouped;
}
