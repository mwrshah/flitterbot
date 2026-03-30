import crypto from "node:crypto";
import type { WorkstreamRow } from "../contracts/index.ts";
import type { BlackboardDatabase, CountRow } from "./db.ts";

export function listOpenWorkstreams(db: BlackboardDatabase): WorkstreamRow[] {
  return db.all<WorkstreamRow>(
    "SELECT * FROM workstreams WHERE status = 'open' ORDER BY created_at DESC",
  );
}

export function getWorkstreamById(db: BlackboardDatabase, id: string): WorkstreamRow | null {
  const row = db.get<WorkstreamRow>("SELECT * FROM workstreams WHERE id = ?", id);
  return row ?? null;
}

export function getWorkstreamByName(db: BlackboardDatabase, name: string): WorkstreamRow | null {
  const row = db.get<WorkstreamRow>(
    "SELECT * FROM workstreams WHERE name = ? COLLATE NOCASE",
    name,
  );
  return row ?? null;
}

export function insertWorkstream(db: BlackboardDatabase, name: string): WorkstreamRow {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO workstreams (id, name) VALUES (?, ?)").run(id, name);
  return getWorkstreamById(db, id)!;
}

export function enrichWorkstream(
  db: BlackboardDatabase,
  workstreamId: string,
  repoPath: string,
  worktreePath?: string,
): void {
  db.prepare(`UPDATE workstreams SET repo_path = ?, worktree_path = ? WHERE id = ?`).run(
    repoPath,
    worktreePath ?? null,
    workstreamId,
  );
}

export function getActivePiSessionId(
  db: BlackboardDatabase,
  workstreamId: string,
): string | undefined {
  const row = db.get<{ pi_session_id: string }>(
    `SELECT pi_session_id FROM pi_sessions WHERE workstream_id = ? AND status != 'ended' ORDER BY started_at DESC LIMIT 1`,
    workstreamId,
  );
  return row?.pi_session_id;
}

/** Returns the most recent pi_session_id for a workstream, regardless of session status. */
export function getLatestPiSessionId(
  db: BlackboardDatabase,
  workstreamId: string,
): string | undefined {
  const row = db.get<{ pi_session_id: string }>(
    `SELECT pi_session_id FROM pi_sessions WHERE workstream_id = ? ORDER BY started_at DESC LIMIT 1`,
    workstreamId,
  );
  return row?.pi_session_id;
}

export function getWorkstreamForPiSession(
  db: BlackboardDatabase,
  piSessionId: string,
): WorkstreamRow | null {
  const row = db.get<WorkstreamRow>(
    `SELECT w.* FROM workstreams w
     JOIN pi_sessions p ON p.workstream_id = w.id
     WHERE p.pi_session_id = ?`,
    piSessionId,
  );
  return row ?? null;
}

export function closeWorkstream(db: BlackboardDatabase, workstreamId: string): void {
  db.prepare(
    `UPDATE workstreams
		 SET status = 'closed', closed_at = datetime('now')
		 WHERE id = ? AND status = 'open'`,
  ).run(workstreamId);
}

export function reopenWorkstream(
  db: BlackboardDatabase,
  workstreamId: string,
): WorkstreamRow | null {
  db.prepare(`UPDATE workstreams SET status = 'open', closed_at = NULL WHERE id = ?`).run(
    workstreamId,
  );
  return getWorkstreamById(db, workstreamId);
}

export function resetAllWorkstreams(db: BlackboardDatabase): number {
  const count = db.get<CountRow>("SELECT COUNT(*) as count FROM workstreams");
  db.prepare("DELETE FROM workstreams").run();
  return count?.count ?? 0;
}

/** Returns created_at of the most recent workstream before the given one, or undefined if none. */
export function getPreviousWorkstreamCreatedAt(
  db: BlackboardDatabase,
  excludeId: string,
): string | undefined {
  const row = db.get<{ created_at: string }>(
    `SELECT created_at FROM workstreams WHERE id != ? ORDER BY created_at DESC LIMIT 1`,
    excludeId,
  );
  return row?.created_at;
}

export function listRecentlyClosedWorkstreams(
  db: BlackboardDatabase,
  withinHours: number,
): WorkstreamRow[] {
  return db.all<WorkstreamRow>(
    `SELECT * FROM workstreams
			 WHERE status = 'closed'
			   AND closed_at >= datetime('now', '-' || ? || ' hours')
			 ORDER BY closed_at DESC`,
    withinHours,
  );
}
