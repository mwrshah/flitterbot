import crypto from "node:crypto";
import type { PiSessionStatus, StreamRow, StreamType } from "../contracts/index.ts";
import type { BlackboardDatabase, CountRow } from "./db.ts";

export function listOpenStreams(db: BlackboardDatabase): StreamRow[] {
  return db.all<StreamRow>(
    "SELECT * FROM streams WHERE status = 'open' ORDER BY pinned DESC, created_at DESC",
  );
}

export function listOpenWorkStreams(db: BlackboardDatabase, streamUser?: string): StreamRow[] {
  if (streamUser) {
    return db.all<StreamRow>(
      "SELECT * FROM streams WHERE status = 'open' AND type = 'work' AND stream_user = ? ORDER BY pinned DESC, created_at DESC",
      streamUser,
    );
  }
  return db.all<StreamRow>(
    "SELECT * FROM streams WHERE status = 'open' AND type = 'work' ORDER BY pinned DESC, created_at DESC",
  );
}

export function getStreamById(db: BlackboardDatabase, id: string): StreamRow | null {
  const row = db.get<StreamRow>("SELECT * FROM streams WHERE id = ?", id);
  return row ?? null;
}

export function getStreamByName(db: BlackboardDatabase, name: string): StreamRow | null {
  const row = db.get<StreamRow>("SELECT * FROM streams WHERE name = ? COLLATE NOCASE", name);
  return row ?? null;
}

export function setStreamPinned(
  db: BlackboardDatabase,
  streamId: string,
  pinned: boolean,
): StreamRow | null {
  db.prepare("UPDATE streams SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, streamId);
  return getStreamById(db, streamId);
}

export function setStreamName(
  db: BlackboardDatabase,
  streamId: string,
  name: string,
): StreamRow | null {
  db.prepare("UPDATE streams SET name = ? WHERE id = ?").run(name, streamId);
  return getStreamById(db, streamId);
}

export function insertStream(
  db: BlackboardDatabase,
  name: string,
  type: StreamType = "work",
  streamUser?: string,
): StreamRow {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO streams (id, name, type, stream_user) VALUES (?, ?, ?, ?)").run(
    id,
    name,
    type,
    streamUser ?? null,
  );
  return getStreamById(db, id)!;
}

export function setStreamType(
  db: BlackboardDatabase,
  streamId: string,
  type: StreamType,
): StreamRow | null {
  db.prepare("UPDATE streams SET type = ? WHERE id = ?").run(type, streamId);
  return getStreamById(db, streamId);
}

export function enrichStream(
  db: BlackboardDatabase,
  streamId: string,
  repoPath: string,
  worktreePath?: string,
  baseBranch?: string,
): void {
  if (baseBranch !== undefined) {
    db.prepare(
      `UPDATE streams SET repo_path = ?, worktree_path = ?, base_branch = ? WHERE id = ?`,
    ).run(repoPath, worktreePath ?? null, baseBranch, streamId);
  } else {
    db.prepare(`UPDATE streams SET repo_path = ?, worktree_path = ? WHERE id = ?`).run(
      repoPath,
      worktreePath ?? null,
      streamId,
    );
  }
}

export function updateStreamRepoPath(
  db: BlackboardDatabase,
  streamId: string,
  repoPath: string,
): void {
  db.prepare(`UPDATE streams SET repo_path = ? WHERE id = ?`).run(repoPath, streamId);
}

export function getActivePiSessionId(db: BlackboardDatabase, streamId: string): string | undefined {
  const row = db.get<{ pi_session_id: string }>(
    `SELECT pi_session_id FROM pi_sessions WHERE stream_id = ? AND status != 'ended' ORDER BY started_at DESC LIMIT 1`,
    streamId,
  );
  return row?.pi_session_id;
}

export function getPiSessionStatus(
  db: BlackboardDatabase,
  piSessionId: string,
): PiSessionStatus | undefined {
  const row = db.get<{ status: PiSessionStatus }>(
    `SELECT status FROM pi_sessions WHERE pi_session_id = ?`,
    piSessionId,
  );
  return row?.status;
}

export function getLatestPiSessionId(db: BlackboardDatabase, streamId: string): string | undefined {
  const row = db.get<{ pi_session_id: string }>(
    `SELECT pi_session_id FROM pi_sessions WHERE stream_id = ? ORDER BY started_at DESC LIMIT 1`,
    streamId,
  );
  return row?.pi_session_id;
}

export function getStreamForPiSession(
  db: BlackboardDatabase,
  piSessionId: string,
): StreamRow | null {
  const row = db.get<StreamRow>(
    `SELECT w.* FROM streams w
     JOIN pi_sessions p ON p.stream_id = w.id
     WHERE p.pi_session_id = ?`,
    piSessionId,
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

export function deleteStream(db: BlackboardDatabase, streamId: string): void {
  db.prepare("DELETE FROM streams WHERE id = ?").run(streamId);
}

export function resetClosedStreams(db: BlackboardDatabase): number {
  const count = db.get<CountRow>("SELECT COUNT(*) as count FROM streams WHERE status = 'closed'");
  db.prepare("DELETE FROM streams WHERE status = 'closed'").run();
  return count?.count ?? 0;
}

export function getPreviousStreamCreatedAt(
  db: BlackboardDatabase,
  excludeId: string,
): string | undefined {
  const row = db.get<{ created_at: string }>(
    `SELECT datetime(created_at) as created_at FROM streams WHERE id != ? AND type = 'work' ORDER BY created_at DESC LIMIT 1`,
    excludeId,
  );
  return row?.created_at;
}

export function getLatestStreamCreatedAt(
  db: BlackboardDatabase,
  streamUser?: string,
): string | undefined {
  if (streamUser) {
    const row = db.get<{ created_at: string }>(
      `SELECT datetime(created_at) as created_at FROM streams WHERE type = 'work' AND stream_user = ? ORDER BY created_at DESC LIMIT 1`,
      streamUser,
    );
    return row?.created_at;
  }
  const row = db.get<{ created_at: string }>(
    `SELECT datetime(created_at) as created_at FROM streams WHERE type = 'work' ORDER BY created_at DESC LIMIT 1`,
  );
  return row?.created_at;
}

export const RECENTLY_CLOSED_WINDOW_HOURS = 24 * 7;

export function listRecentlyClosedStreams(
  db: BlackboardDatabase,
  withinHours: number,
): StreamRow[] {
  return db.all<StreamRow>(
    `SELECT * FROM streams
			 WHERE status = 'closed'
			   AND datetime(closed_at) >= datetime('now', '-' || ? || ' hours')
			 ORDER BY pinned DESC, closed_at DESC`,
    withinHours,
  );
}
