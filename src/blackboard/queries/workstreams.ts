import crypto from "node:crypto";
import type { BlackboardDatabase } from "../db.ts";
import type { WorkstreamRow } from "../../contracts/index.ts";

export function listOpenWorkstreams(db: BlackboardDatabase): WorkstreamRow[] {
	return db
		.prepare("SELECT * FROM workstreams WHERE status = 'open' ORDER BY created_at DESC")
		.all() as unknown as WorkstreamRow[];
}

export function getWorkstreamById(db: BlackboardDatabase, id: string): WorkstreamRow | null {
	const row = db.prepare("SELECT * FROM workstreams WHERE id = ?").get(id) as unknown as WorkstreamRow | undefined;
	return row ?? null;
}

export function getWorkstreamByName(db: BlackboardDatabase, name: string): WorkstreamRow | null {
	const row = db
		.prepare("SELECT * FROM workstreams WHERE name = ? COLLATE NOCASE")
		.get(name) as unknown as WorkstreamRow | undefined;
	return row ?? null;
}

export function insertWorkstream(db: BlackboardDatabase, name: string): WorkstreamRow {
	const id = crypto.randomUUID();
	db.prepare("INSERT INTO workstreams (id, name) VALUES (?, ?)").run(id, name);
	return getWorkstreamById(db, id)!;
}

export function enrichWorkstream(db: BlackboardDatabase, workstreamId: string, repoPath: string, worktreePath?: string): void {
	db.prepare(
		`UPDATE workstreams SET repo_path = ?, worktree_path = ? WHERE id = ?`,
	).run(repoPath, worktreePath ?? null, workstreamId);
}

export function getActivePiSessionId(db: BlackboardDatabase, workstreamId: string): string | undefined {
	const row = db
		.prepare(
			`SELECT pi_session_id FROM pi_sessions WHERE workstream_id = ? AND status != 'ended' ORDER BY started_at DESC LIMIT 1`,
		)
		.get(workstreamId) as { pi_session_id: string } | undefined;
	return row?.pi_session_id;
}

export function closeWorkstream(db: BlackboardDatabase, workstreamId: string): void {
	db.prepare(
		`UPDATE workstreams
		 SET status = 'closed', closed_at = datetime('now')
		 WHERE id = ? AND status = 'open'`,
	).run(workstreamId);
}

export function reopenWorkstream(db: BlackboardDatabase, workstreamId: string): WorkstreamRow | null {
	db.prepare(
		`UPDATE workstreams SET status = 'open', closed_at = NULL WHERE id = ?`,
	).run(workstreamId);
	return getWorkstreamById(db, workstreamId);
}

export function resetAllWorkstreams(db: BlackboardDatabase): number {
	const count = db.prepare("SELECT COUNT(*) as count FROM workstreams").get() as { count: number };
	db.prepare("DELETE FROM workstreams").run();
	return count.count;
}

export function listRecentlyClosedWorkstreams(db: BlackboardDatabase, withinHours: number): WorkstreamRow[] {
	return db
		.prepare(
			`SELECT * FROM workstreams
			 WHERE status = 'closed'
			   AND closed_at >= datetime('now', '-' || ? || ' hours')
			 ORDER BY closed_at DESC`,
		)
		.all(withinHours) as unknown as WorkstreamRow[];
}
