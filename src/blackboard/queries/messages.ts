import type { MessageRow, UnifiedMessageSource } from "../../contracts/index.ts";
import type { BlackboardDatabase } from "../db.ts";
import {
  type InsertMessageInput,
  insertMessage as writeMessage,
} from "../writers/message-writer.ts";

export function insertMessage(db: BlackboardDatabase, input: InsertMessageInput): MessageRow {
  return writeMessage(db, input);
}

export function persistInboundMessage(
  db: BlackboardDatabase,
  opts: {
    source: UnifiedMessageSource;
    content: string;
    sender?: string;
    workstreamId?: string;
    metadata?: Record<string, unknown>;
  },
): MessageRow {
  return writeMessage(db, {
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
    source: UnifiedMessageSource;
    content: string;
    workstreamId?: string;
    metadata?: Record<string, unknown>;
  },
): MessageRow {
  return writeMessage(db, {
    source: opts.source,
    direction: "outbound",
    content: opts.content,
    sender: "pi",
    workstreamId: opts.workstreamId,
    metadata: opts.metadata,
  });
}

export function getRecentMessages(db: BlackboardDatabase, limit: number = 50): MessageRow[] {
  return db
    .prepare("SELECT * FROM messages ORDER BY created_at DESC LIMIT ?")
    .all(limit) as unknown as MessageRow[];
}

export function getMessagesBySource(
  db: BlackboardDatabase,
  source: UnifiedMessageSource,
  limit: number = 50,
): MessageRow[] {
  return db
    .prepare("SELECT * FROM messages WHERE source = ? ORDER BY created_at DESC LIMIT ?")
    .all(source, limit) as unknown as MessageRow[];
}

export function getMessagesByWorkstream(
  db: BlackboardDatabase,
  workstreamId: string,
  limit: number = 100,
): MessageRow[] {
  return db
    .prepare("SELECT * FROM messages WHERE workstream_id = ? ORDER BY created_at ASC LIMIT ?")
    .all(workstreamId, limit) as unknown as MessageRow[];
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

export function getRecentConversationByWorkstream(
  db: BlackboardDatabase,
  withinHours: number,
  maxPerWorkstream: number,
): Map<string, ConversationSnippet[]> {
  const rows = db
    .prepare(
      `SELECT m.workstream_id, w.name AS workstream_name,
            m.content, m.source, m.created_at, m.direction, m.sender
     FROM messages m
     JOIN workstreams w ON w.id = m.workstream_id AND w.status = 'open'
     WHERE m.created_at >= datetime('now', '-' || ? || ' hours')
     ORDER BY m.workstream_id, m.created_at DESC`,
    )
    .all(withinHours) as unknown as ConversationSnippet[];

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
