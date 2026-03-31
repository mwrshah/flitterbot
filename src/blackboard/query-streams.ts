import crypto from "node:crypto";
import type { StreamRow } from "../contracts/index.ts";
import type { BlackboardDatabase, CountRow } from "./db.ts";

export function listOpenStreams(db: BlackboardDatabase): StreamRow[] {
  return db.all<StreamRow>("SELECT * FROM streams WHERE status = 'open' ORDER BY created_at DESC");
}

export function getStreamById(db: BlackboardDatabase, id: string): StreamRow | null {
  const row = db.get<StreamRow>("SELECT * FROM streams WHERE id = ?", id);
  return row ?? null;
}

export function getStreamByName(db: BlackboardDatabase, name: string): StreamRow | null {
  const row = db.get<StreamRow>("SELECT * FROM streams WHERE name = ? COLLATE NOCASE", name);
  return row ?? null;
}

export function insertStream(db: BlackboardDatabase, name: string): StreamRow {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO streams (id, name) VALUES (?, ?)").run(id, name);
  return getStreamById(db, id)!;
}

export function enrichStream(
  db: BlackboardDatabase,
  streamId: string,
  repoPath: string,
  worktreePath?: string,
): void {
  db.prepare(`UPDATE streams SET repo_path = ?, worktree_path = ? WHERE id = ?`).run(
    repoPath,
    worktreePath ?? null,
    streamId,
  );
}

export function getActiveStreamsSessionId(
  db: BlackboardDatabase,
  streamId: string,
): string | undefined {
  const row = db.get<{ pi_session_id: string }>(
    `SELECT pi_session_id FROM pi_sessions WHERE stream_id = ? AND status != 'ended' ORDER BY started_at DESC LIMIT 1`,
    streamId,
  );
  return row?.pi_session_id;
}

/** Returns the most recent pi_session_id for a stream, regardless of session status. */
export function getLatestStreamsSessionId(
  db: BlackboardDatabase,
  streamId: string,
): string | undefined {
  const row = db.get<{ pi_session_id: string }>(
    `SELECT pi_session_id FROM pi_sessions WHERE stream_id = ? ORDER BY started_at DESC LIMIT 1`,
    streamId,
  );
  return row?.pi_session_id;
}

export function getStreamForStreamsSession(
  db: BlackboardDatabase,
  streamsSessionId: string,
): StreamRow | null {
  const row = db.get<StreamRow>(
    `SELECT w.* FROM streams w
     JOIN pi_sessions p ON p.stream_id = w.id
     WHERE p.pi_session_id = ?`,
    streamsSessionId,
  );
  return row ?? null;
}

export function closeStream(db: BlackboardDatabase, streamId: string): void {
  db.prepare(
    `UPDATE streams
		 SET status = 'closed', closed_at = datetime('now')
		 WHERE id = ? AND status = 'open'`,
  ).run(streamId);
}

export function reopenStream(db: BlackboardDatabase, streamId: string): StreamRow | null {
  db.prepare(`UPDATE streams SET status = 'open', closed_at = NULL WHERE id = ?`).run(streamId);
  return getStreamById(db, streamId);
}

export function resetAllStreams(db: BlackboardDatabase): number {
  const count = db.get<CountRow>("SELECT COUNT(*) as count FROM streams");
  db.prepare("DELETE FROM streams").run();
  return count?.count ?? 0;
}

/** Returns created_at of the most recent stream before the given one, or undefined if none. */
export function getPreviousStreamCreatedAt(
  db: BlackboardDatabase,
  excludeId: string,
): string | undefined {
  const row = db.get<{ created_at: string }>(
    `SELECT created_at FROM streams WHERE id != ? ORDER BY created_at DESC LIMIT 1`,
    excludeId,
  );
  return row?.created_at;
}

export function listRecentlyClosedStreams(
  db: BlackboardDatabase,
  withinHours: number,
): StreamRow[] {
  return db.all<StreamRow>(
    `SELECT * FROM streams
			 WHERE status = 'closed'
			   AND closed_at >= datetime('now', '-' || ? || ' hours')
			 ORDER BY closed_at DESC`,
    withinHours,
  );
}
