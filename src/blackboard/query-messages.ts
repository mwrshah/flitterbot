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
    streamId?: string;
    piSessionId?: string;
    metadata?: MessageMetadata;
  },
): MessageRow {
  return writeMessage(db, {
    id: opts.id,
    source: opts.source,
    direction: "inbound",
    content: opts.content,
    sender: opts.sender,
    streamId: opts.streamId,
    piSessionId: opts.piSessionId,
    metadata: opts.metadata,
  });
}

export function persistOutboundMessage(
  db: BlackboardDatabase,
  opts: {
    id?: string;
    source: UnifiedMessageSource;
    content: string;
    streamId?: string;
    piSessionId?: string;
    metadata?: MessageMetadata;
  },
): MessageRow {
  return writeMessage(db, {
    id: opts.id,
    source: opts.source,
    direction: "outbound",
    content: opts.content,
    sender: "pi",
    streamId: opts.streamId,
    piSessionId: opts.piSessionId,
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
  streamId: string,
  limit: number = 100,
): MessageRow[] {
  return db.all<MessageRow>(
    "SELECT * FROM messages WHERE stream_id = ? ORDER BY created_at ASC LIMIT ?",
    streamId,
    limit,
  );
}

export type ConversationSnippet = {
  stream_id: string;
  stream_name: string;
  content: string;
  source: string;
  created_at: string;
  direction: "inbound" | "outbound";
  sender: string | null;
};

export function getRecentDefaultMessages(
  db: BlackboardDatabase,
  limit: number = 10,
  after?: string,
): Pick<MessageRow, "content" | "created_at">[] {
  const rows = after
    ? db.all<Pick<MessageRow, "content" | "created_at">>(
        `SELECT content, created_at FROM messages
         WHERE direction = 'inbound' AND stream_id IS NULL AND datetime(created_at) > datetime(?)
         ORDER BY created_at DESC LIMIT ?`,
        after,
        limit,
      )
    : db.all<Pick<MessageRow, "content" | "created_at">>(
        `SELECT content, created_at FROM messages
         WHERE direction = 'inbound' AND stream_id IS NULL
         ORDER BY created_at DESC LIMIT ?`,
        limit,
      );
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
  piSessionId: string,
  limit: number = 10,
): DefaultConversationSnippet[] {
  const rows = db.all<DefaultConversationSnippet>(
    `SELECT content, source, created_at, direction, sender
     FROM messages
     WHERE pi_session_id = ?
     ORDER BY created_at DESC LIMIT ?`,
    piSessionId,
    limit,
  );
  return rows.reverse();
}

/**
 * Returns surfaced messages (web/whatsapp inbound + stream_outbound) for the input
 * surface, scoped to a set of active pi_session_ids.
 */
export function getInputSurfaceHistory(
  db: BlackboardDatabase,
  piSessionIds: string[],
): (MessageRow & { stream_name: string | null })[] {
  if (piSessionIds.length === 0) return [];
  const placeholders = piSessionIds.map(() => "?").join(", ");
  return db.all<MessageRow & { stream_name: string | null }>(
    `SELECT m.*, w.name AS stream_name
     FROM messages m
     LEFT JOIN streams w ON w.id = m.stream_id
     WHERE ((m.source IN ('web', 'whatsapp') AND m.direction = 'inbound')
            OR (m.source = 'stream_outbound' AND m.direction = 'outbound'))
       AND m.pi_session_id IN (${placeholders})
     ORDER BY m.created_at ASC`,
    ...piSessionIds,
  );
}

export function getRecentConversationByWorkstream(
  db: BlackboardDatabase,
  withinHours: number,
  maxPerWorkstream: number,
): Map<string, ConversationSnippet[]> {
  const rows = db.all<ConversationSnippet>(
    `SELECT m.stream_id, w.name AS stream_name,
            m.content, m.source, m.created_at, m.direction, m.sender
     FROM messages m
     JOIN streams w ON w.id = m.stream_id AND w.status = 'open'
     WHERE datetime(m.created_at) >= datetime('now', '-' || ? || ' hours')
     ORDER BY m.stream_id, m.created_at DESC`,
    withinHours,
  );

  const grouped = new Map<string, ConversationSnippet[]>();
  for (const row of rows) {
    const list = grouped.get(row.stream_id) ?? [];
    if (list.length < maxPerWorkstream) {
      list.push(row);
    }
    grouped.set(row.stream_id, list);
  }
  return grouped;
}
