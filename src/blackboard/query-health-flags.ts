import type { HealthFlagRow } from "../contracts/index.ts";
import type { BlackboardDatabase } from "./db.ts";

export function setHealthFlag(
  db: BlackboardDatabase,
  flag: string,
  reason: string,
  ttlMinutes?: number,
): void {
  const expiresAt =
    ttlMinutes != null
      ? new Date(Date.now() + ttlMinutes * 60_000).toISOString().replace(/\.\d+Z$/, "Z")
      : null;
  db.prepare(
    `INSERT INTO health_flags (flag, reason, set_at, expires_at, cleared_at)
     VALUES (?, ?, datetime('now'), ?, NULL)
     ON CONFLICT(flag) DO UPDATE SET
       reason = excluded.reason,
       set_at = excluded.set_at,
       expires_at = excluded.expires_at,
       cleared_at = NULL`,
  ).run(flag, reason, expiresAt);
}

export function getActiveHealthFlags(db: BlackboardDatabase): HealthFlagRow[] {
  return db.all<HealthFlagRow>(
    `SELECT * FROM health_flags
     WHERE cleared_at IS NULL
       AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))`,
  );
}

export function clearHealthFlag(db: BlackboardDatabase, flag: string): void {
  db.prepare(
    `UPDATE health_flags SET cleared_at = datetime('now') WHERE flag = ? AND cleared_at IS NULL`,
  ).run(flag);
}

export function clearAllHealthFlags(db: BlackboardDatabase): void {
  db.prepare(`UPDATE health_flags SET cleared_at = datetime('now') WHERE cleared_at IS NULL`).run();
}
