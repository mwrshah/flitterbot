import { describe, expect, test } from "bun:test";
import type { BlackboardDatabase, CountRow } from "./db.ts";
import { resetClosedStreams } from "./query-streams.ts";

function fakeDb(closedCount: number): { db: BlackboardDatabase; statements: string[] } {
  const statements: string[] = [];
  const db = {
    get: (sql: string): CountRow => {
      statements.push(sql);
      return { count: closedCount };
    },
    prepare: (sql: string) => {
      statements.push(sql);
      return { run: () => undefined };
    },
  } as unknown as BlackboardDatabase;
  return { db, statements };
}

describe("stream reset", () => {
  test("removes only closed streams", () => {
    const { db, statements } = fakeDb(3);

    expect(resetClosedStreams(db)).toBe(3);
    expect(statements).toEqual([
      "SELECT COUNT(*) as count FROM streams WHERE status = 'closed'",
      "DELETE FROM streams WHERE status = 'closed'",
    ]);
  });
});
