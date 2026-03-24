import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { migrateBlackboard } from "./migrate.ts";

export class BlackboardDatabase {
  readonly path: string;
  readonly sqlite: DatabaseSync;

  constructor(dbPath: string) {
    this.path = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.sqlite = new DatabaseSync(dbPath);
    this.sqlite.exec("PRAGMA journal_mode=WAL;");
    this.sqlite.exec("PRAGMA busy_timeout=5000;");
    this.sqlite.exec("PRAGMA foreign_keys=ON;");
    migrateBlackboard(this.sqlite);
  }

  exec(sql: string): void {
    this.sqlite.exec(sql);
  }

  prepare(sql: string): StatementSync {
    return this.sqlite.prepare(sql);
  }

  run(sql: string, ...params: Array<unknown>): void {
    this.prepare(sql).run(...(params as Array<import("node:sqlite").SQLInputValue>));
  }

  get<T = Record<string, unknown>>(sql: string, ...params: Array<unknown>): T | undefined {
    return this.prepare(sql).get(...(params as Array<import("node:sqlite").SQLInputValue>)) as
      | T
      | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: Array<unknown>): T[] {
    return this.prepare(sql).all(...(params as Array<import("node:sqlite").SQLInputValue>)) as T[];
  }

  ping(): boolean {
    const row = this.get<{ ok: number }>("SELECT 1 AS ok");
    return row?.ok === 1;
  }

  close(): void {
    this.sqlite.close();
  }
}

export function openBlackboard(dbPath: string): BlackboardDatabase {
  return new BlackboardDatabase(dbPath);
}

export function pingBlackboard(db: BlackboardDatabase): boolean {
  return db.ping();
}

/* ── Message ID mapping helpers ── */

export function insertIdMapping(
  db: BlackboardDatabase,
  serverId: string,
  agentId: string,
  piSessionId?: string,
): void {
  db.run(
    `INSERT OR IGNORE INTO message_id_map (server_id, agent_id, pi_session_id) VALUES (?, ?, ?)`,
    serverId,
    agentId,
    piSessionId ?? null,
  );
}

export function resolveServerId(
  db: BlackboardDatabase,
  agentId: string,
): string | null {
  const row = db.get<{ server_id: string }>(
    "SELECT server_id FROM message_id_map WHERE agent_id = ?",
    agentId,
  );
  return row?.server_id ?? null;
}

/** Returns a resolver function suitable for passing to the history parser. */
export function createIdResolver(
  db: BlackboardDatabase,
): (agentId: string) => string | null {
  return (agentId: string) => resolveServerId(db, agentId);
}
