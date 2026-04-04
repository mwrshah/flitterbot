import type { UserConfigRow } from "../contracts/blackboard.ts";
import type { BlackboardDatabase } from "./db.ts";

export function getUserConfig(
  db: BlackboardDatabase,
  userId: string,
): Record<string, string> {
  const rows = db.all<UserConfigRow>(
    "SELECT key, value FROM user_config WHERE user_id = ?",
    userId,
  );
  const config: Record<string, string> = {};
  for (const row of rows) {
    config[row.key] = row.value;
  }
  return config;
}

export function setUserConfig(
  db: BlackboardDatabase,
  userId: string,
  entries: Record<string, string>,
): void {
  const stmt = db.prepare(
    `INSERT INTO user_config (user_id, key, value, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  for (const [key, value] of Object.entries(entries)) {
    stmt.run(userId, key, value);
  }
}
