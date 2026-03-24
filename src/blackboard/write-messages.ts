import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  MessageRow,
  UnifiedMessageDirection,
  UnifiedMessageSource,
} from "../contracts/index.ts";

type SqlDatabase = Pick<DatabaseSync, "prepare">;

export type InsertMessageInput = {
  id?: string;
  source: UnifiedMessageSource;
  direction: UnifiedMessageDirection;
  content: string;
  sender?: string | null;
  workstreamId?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
};

function timestamp(value?: string): string {
  return value ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function insertMessage(db: SqlDatabase, input: InsertMessageInput): MessageRow {
  const id = input.id ?? crypto.randomUUID();
  const createdAt = timestamp(input.createdAt);
  const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;

  db.prepare(
    `INSERT INTO messages (id, source, direction, content, sender, workstream_id, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.source,
    input.direction,
    input.content,
    input.sender ?? null,
    input.workstreamId ?? null,
    metadataJson,
    createdAt,
  );

  return db
    .prepare("SELECT * FROM messages WHERE id = ?")
    .get(id) as unknown as MessageRow;
}
