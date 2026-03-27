import crypto from "node:crypto";
import type {
  MessageMetadata,
  MessageRow,
  UnifiedMessageDirection,
  UnifiedMessageSource,
} from "../contracts/index.ts";
import type { BlackboardDatabase } from "./db.ts";

export type InsertMessageInput = {
  id?: string;
  source: UnifiedMessageSource;
  direction: UnifiedMessageDirection;
  content: string;
  sender?: string | null;
  workstreamId?: string | null;
  piSessionId?: string | null;
  metadata?: MessageMetadata | null;
  createdAt?: string;
};

function timestamp(value?: string): string {
  return value ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function insertMessage(db: BlackboardDatabase, input: InsertMessageInput): MessageRow {
  const id = input.id ?? crypto.randomUUID();
  const createdAt = timestamp(input.createdAt);
  const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;

  db.prepare(
    `INSERT INTO messages (id, source, direction, content, sender, workstream_id, pi_session_id, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.source,
    input.direction,
    input.content,
    input.sender ?? null,
    input.workstreamId ?? null,
    input.piSessionId ?? null,
    metadataJson,
    createdAt,
  );

  return db.get<MessageRow>("SELECT * FROM messages WHERE id = ?", id)!;
}
