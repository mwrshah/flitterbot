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

export function nextStreamName(name: string): string {
  const numbered = /^([1-9]\d*)(\D.*)$/.exec(name);
  return numbered && BigInt(numbered[1]!) >= 2n
    ? `${BigInt(numbered[1]!) + 1n}${numbered[2]}`
    : `2${name}`;
}

function availableStreamName(
  db: BlackboardDatabase,
  requestedName: string,
  excludeStreamId?: string,
): string {
  let candidate = requestedName;
  let collision = getStreamByName(db, candidate);
  while (collision && collision.id !== excludeStreamId) {
    candidate = nextStreamName(candidate);
    collision = getStreamByName(db, candidate);
  }
  return candidate;
}

export function setStreamName(
  db: BlackboardDatabase,
  streamId: string,
  name: string,
): StreamRow | null {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const availableName = availableStreamName(db, name, streamId);
    db.prepare("UPDATE streams SET name = ? WHERE id = ?").run(availableName, streamId);
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
  return getStreamById(db, streamId);
}

export function insertStream(
  db: BlackboardDatabase,
  name: string,
  type: StreamType = "work",
  streamUser?: string,
): StreamRow {
  const id = crypto.randomUUID();
  db.exec("BEGIN IMMEDIATE;");
  try {
    const availableName = availableStreamName(db, name);
    db.prepare("INSERT INTO streams (id, name, type, stream_user) VALUES (?, ?, ?, ?)").run(
      id,
      availableName,
      type,
      streamUser ?? null,
    );
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
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

export type StreamPiSessionRow = {
  pi_session_id: string;
  role: "default" | "orchestrator";
  session_file: string | null;
  cwd: string;
  started_at: string;
  model_provider: string | null;
  model_id: string | null;
  status: PiSessionStatus;
  ended_at: string | null;
  end_reason: string | null;
  last_event_at: string;
};

export function getStreamPiSessionRow(
  db: BlackboardDatabase,
  streamId: string,
): StreamPiSessionRow | null {
  return (
    db.get<StreamPiSessionRow>(
      `SELECT pi_session_id, role, session_file, cwd, started_at, model_provider, model_id, status,
              ended_at, end_reason, last_event_at
       FROM pi_sessions
       WHERE stream_id = ?
       LIMIT 1`,
      streamId,
    ) ?? null
  );
}

export function getActiveStreamPiSessionId(
  db: BlackboardDatabase,
  streamId: string,
): string | undefined {
  const session = getStreamPiSessionRow(db, streamId);
  return session?.status !== "ended" ? session?.pi_session_id : undefined;
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

export function getStreamPiSessionId(db: BlackboardDatabase, streamId: string): string | undefined {
  return getStreamPiSessionRow(db, streamId)?.pi_session_id;
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

export function finalizeStreamCloseRows(
  db: BlackboardDatabase,
  streamId: string,
  piSessionId: string,
  endedAt: string,
  endReason = "stream_closed",
): StreamRow | null {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const streamUpdate = db
      .prepare(
        `UPDATE streams
         SET status = 'closed', closed_at = ?
         WHERE id = ?`,
      )
      .run(endedAt, streamId);
    if (streamUpdate.changes !== 1) throw new Error(`Cannot close missing stream ${streamId}`);
    const piSessionUpdate = db
      .prepare(
        `UPDATE pi_sessions
       SET status = 'ended',
           ended_at = ?,
           end_reason = ?,
           last_event_at = MAX(last_event_at, ?)
       WHERE pi_session_id = ? AND stream_id = ?`,
      )
      .run(endedAt, endReason, endedAt, piSessionId, streamId);
    if (piSessionUpdate.changes !== 1) {
      throw new Error(`Cannot close stream ${streamId}: Pi session ${piSessionId} is not linked`);
    }
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
  return getStreamById(db, streamId);
}

export function reopenStreamRows(
  db: BlackboardDatabase,
  streamId: string,
  piSessionId: string,
  reopenedAt: string,
): StreamRow | null {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const streamUpdate = db
      .prepare(`UPDATE streams SET status = 'open', closed_at = NULL WHERE id = ?`)
      .run(streamId);
    if (streamUpdate.changes !== 1) throw new Error(`Cannot reopen missing stream ${streamId}`);
    const piSessionUpdate = db
      .prepare(
        `UPDATE pi_sessions
         SET status = 'waiting_for_user',
             ended_at = NULL,
             end_reason = NULL,
             last_event_at = MAX(last_event_at, ?)
         WHERE pi_session_id = ? AND stream_id = ?`,
      )
      .run(reopenedAt, piSessionId, streamId);
    if (piSessionUpdate.changes !== 1) {
      throw new Error(`Cannot reopen stream ${streamId}: Pi session ${piSessionId} is not linked`);
    }
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
  return getStreamById(db, streamId);
}

export function rollbackStreamReopenRows(
  db: BlackboardDatabase,
  stream: Pick<StreamRow, "id" | "status" | "closed_at">,
  piSession: {
    piSessionId: string;
    status: PiSessionStatus;
    endedAt: string | null;
    endReason: string | null;
    lastEventAt: string;
  },
): void {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const streamUpdate = db
      .prepare("UPDATE streams SET status = ?, closed_at = ? WHERE id = ?")
      .run(stream.status, stream.closed_at, stream.id);
    if (streamUpdate.changes !== 1) throw new Error(`Cannot roll back missing stream ${stream.id}`);
    const piSessionUpdate = db
      .prepare(
        `UPDATE pi_sessions
         SET status = ?, ended_at = ?, end_reason = ?, last_event_at = ?
         WHERE pi_session_id = ? AND stream_id = ?`,
      )
      .run(
        piSession.status,
        piSession.endedAt,
        piSession.endReason,
        piSession.lastEventAt,
        piSession.piSessionId,
        stream.id,
      );
    if (piSessionUpdate.changes !== 1) {
      throw new Error(
        `Cannot roll back stream ${stream.id}: Pi session ${piSession.piSessionId} is not linked`,
      );
    }
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
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

export const CLOSED_STREAM_LOOKBACK_HOURS = 24 * 7;

export function listClosedStreams(
  db: BlackboardDatabase,
  withinHours: number,
  includePinnedBeyondLookback: boolean,
): StreamRow[] {
  return db.all<StreamRow>(
    `SELECT * FROM streams
			 WHERE status = 'closed'
			   AND (
			     (? = 1 AND pinned = 1)
			     OR datetime(closed_at) >= datetime('now', '-' || ? || ' hours')
			   )
			 ORDER BY pinned DESC, closed_at DESC`,
    includePinnedBeyondLookback ? 1 : 0,
    withinHours,
  );
}
