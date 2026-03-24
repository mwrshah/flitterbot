import type { HealthFlagRow } from "../contracts/index.ts";
import type { BlackboardDatabase } from "./db.ts";

/**
 * Set a health flag (circuit breaker). Upserts — re-setting an existing flag
 * updates the reason, timestamp, and TTL.
 */
export function setHealthFlag(
  db: BlackboardDatabase,
  flag: string,
  reason: string,
  ttlMinutes?: number,
): void {
  const expiresAt =
    ttlMinutes != null ? new Date(Date.now() + ttlMinutes * 60_000).toISOString() : null;
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

/**
 * Get all active (unexpired, uncleared) health flags.
 */
export function getActiveHealthFlags(db: BlackboardDatabase): HealthFlagRow[] {
  return db
    .prepare(
      `SELECT * FROM health_flags
     WHERE cleared_at IS NULL
       AND (expires_at IS NULL OR expires_at > datetime('now'))`,
    )
    .all() as unknown as HealthFlagRow[];
}

/**
 * Clear a specific health flag by name.
 */
export function clearHealthFlag(db: BlackboardDatabase, flag: string): void {
  db.prepare(
    `UPDATE health_flags SET cleared_at = datetime('now') WHERE flag = ? AND cleared_at IS NULL`,
  ).run(flag);
}

/**
 * Clear all health flags. Used on control surface startup for a clean slate.
 */
export function clearAllHealthFlags(db: BlackboardDatabase): void {
  db.prepare(`UPDATE health_flags SET cleared_at = datetime('now') WHERE cleared_at IS NULL`).run();
}
