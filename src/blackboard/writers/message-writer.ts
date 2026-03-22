import type { DatabaseSync } from "node:sqlite";
import type {
  MessageRow,
  UnifiedMessageDirection,
  UnifiedMessageSource,
} from "../../contracts/index.ts";

type SqlDatabase = Pick<DatabaseSync, "prepare">;

export type InsertMessageInput = {
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
  const createdAt = timestamp(input.createdAt);
  const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;

  const result = db
    .prepare(
      `INSERT INTO messages (source, direction, content, sender, workstream_id, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
    .get(Number(result.lastInsertRowid)) as unknown as MessageRow;
}
