import type { DatabaseSync } from "node:sqlite";
import { BLACKBOARD_SCHEMA_SQL, BLACKBOARD_SCHEMA_VERSION } from "../contracts/index.ts";

const LATEST_BLACKBOARD_SCHEMA_VERSION = BLACKBOARD_SCHEMA_VERSION;

function hasTable(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function getSchemaVersion(db: DatabaseSync): number {
  if (!hasTable(db, "schema_migrations")) {
    return 0;
  }
  const row = db
    .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
    .get() as {
    version: number;
  };
  return Number(row.version ?? 0);
}

function hasLegacyMarkers(db: DatabaseSync): boolean {
  if (!hasTable(db, "sessions")) {
    return false;
  }
  if (hasTable(db, "agents") || !hasTable(db, "pi_sessions")) {
    return true;
  }
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM sessions WHERE status = 'running'")
    .get() as {
    count: number;
  };
  return Number(row.count ?? 0) > 0;
}

function ensureMigrationsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at DATETIME NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function applyFullSchema(db: DatabaseSync): void {
  db.exec(BLACKBOARD_SCHEMA_SQL);
}

function applyLegacyUpgrade(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys=OFF;");
  db.exec("BEGIN IMMEDIATE;");

  try {
    db.exec(`
      DROP INDEX IF EXISTS idx_sessions_status;
      DROP INDEX IF EXISTS idx_sessions_project;
      DROP INDEX IF EXISTS idx_sessions_last_event_at;
      DROP INDEX IF EXISTS idx_events_session_id;
      DROP INDEX IF EXISTS idx_events_timestamp;
      DROP INDEX IF EXISTS idx_events_session_event;
      DROP INDEX IF EXISTS idx_pi_sessions_status;
      DROP INDEX IF EXISTS idx_pi_sessions_role_status;
      DROP INDEX IF EXISTS idx_pi_sessions_last_event_at;
      DROP INDEX IF EXISTS idx_whatsapp_status_created;
      DROP INDEX IF EXISTS idx_pending_actions_status_created;
    `);

    if (hasTable(db, "events")) {
      db.exec("DROP TABLE events;");
    }
    if (hasTable(db, "events_legacy")) {
      db.exec("DROP TABLE events_legacy;");
    }
    if (hasTable(db, "sessions")) {
      db.exec("ALTER TABLE sessions RENAME TO sessions_legacy;");
    }

    applyFullSchema(db);

    if (hasTable(db, "sessions_legacy")) {
      db.exec(`
        INSERT INTO sessions (
          session_id,
          tmux_session,
          cwd,
          project,
          project_label,
          model,
          permission_mode,
          source,
          status,
          transcript_path,
          task_description,
          todoist_task_id,
          agent_managed,
          session_end_reason,
          started_at,
          ended_at,
          last_event_at,
          last_tool_started_at
        )
        SELECT
          session_id,
          tmux_session,
          COALESCE(NULLIF(cwd, ''), '.') AS cwd,
          COALESCE(NULLIF(project, ''), NULLIF(project_label, ''), COALESCE(NULLIF(cwd, ''), 'unknown')) AS project,
          project_label,
          model,
          permission_mode,
          source,
          CASE
            WHEN status = 'running' THEN 'working'
            WHEN status IN ('working', 'idle', 'stale', 'ended') THEN status
            ELSE 'working'
          END AS status,
          transcript_path,
          task_description,
          todoist_task_id,
          COALESCE(agent_managed, 0),
          session_end_reason,
          COALESCE(started_at, last_event_at, datetime('now')),
          ended_at,
          COALESCE(last_event_at, started_at, datetime('now')),
          last_tool_started_at
        FROM sessions_legacy
      `);
    }

    db.exec(`
      DROP TABLE IF EXISTS sessions_legacy;
      DROP TABLE IF EXISTS agents;
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (3);
    `);

    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys=ON;");
  }
}

function applyV4Migration(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys=OFF;");
  db.exec("BEGIN IMMEDIATE;");

  try {
    // Add workstreams table
    db.exec(`
      CREATE TABLE IF NOT EXISTS workstreams (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          repo_path TEXT,
          worktree_path TEXT,
          created_at DATETIME NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Add workstream_id column to sessions
    db.exec(
      "ALTER TABLE sessions ADD COLUMN workstream_id TEXT REFERENCES workstreams(id) ON DELETE SET NULL;",
    );

    // Recreate pi_sessions with updated status CHECK constraint
    db.exec(`
      CREATE TABLE pi_sessions_v4 (
          pi_session_id TEXT PRIMARY KEY,
          role TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('active', 'idle', 'waiting_for_user', 'waiting_for_sessions', 'ended', 'crashed')),
          runtime_instance_id TEXT,
          pid INTEGER,
          session_file TEXT,
          cwd TEXT NOT NULL,
          agent_dir TEXT,
          model_provider TEXT,
          model_id TEXT,
          thinking_level TEXT,
          started_at DATETIME NOT NULL,
          last_prompt_at DATETIME,
          last_event_at DATETIME NOT NULL,
          ended_at DATETIME,
          end_reason TEXT
      );
      INSERT INTO pi_sessions_v4 SELECT * FROM pi_sessions;
      DROP TABLE pi_sessions;
      ALTER TABLE pi_sessions_v4 RENAME TO pi_sessions;

      CREATE INDEX IF NOT EXISTS idx_pi_sessions_status ON pi_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_pi_sessions_role_status ON pi_sessions(role, status);
      CREATE INDEX IF NOT EXISTS idx_pi_sessions_last_event_at ON pi_sessions(last_event_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_workstream ON sessions(workstream_id);
      CREATE INDEX IF NOT EXISTS idx_workstreams_name ON workstreams(name);

      INSERT OR IGNORE INTO schema_migrations(version) VALUES (4);
    `);

    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys=ON;");
  }
}

function applyV5Migration(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys=OFF;");
  db.exec("BEGIN IMMEDIATE;");

  try {
    // 1. Add pi_session_id to sessions
    db.exec(
      "ALTER TABLE sessions ADD COLUMN pi_session_id TEXT REFERENCES pi_sessions(pi_session_id) ON DELETE SET NULL;",
    );
    db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_pi_session ON sessions(pi_session_id);");

    // 2. Add status + closed_at to workstreams
    db.exec(
      "ALTER TABLE workstreams ADD COLUMN status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed'));",
    );
    db.exec("ALTER TABLE workstreams ADD COLUMN closed_at TEXT;");

    // 3. Recreate pi_sessions without 'idle' in CHECK constraint, migrate idle → waiting_for_user
    db.exec(`
      CREATE TABLE pi_sessions_v5 (
          pi_session_id TEXT PRIMARY KEY,
          role TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('active', 'waiting_for_user', 'waiting_for_sessions', 'ended', 'crashed')),
          runtime_instance_id TEXT,
          pid INTEGER,
          session_file TEXT,
          cwd TEXT NOT NULL,
          agent_dir TEXT,
          model_provider TEXT,
          model_id TEXT,
          thinking_level TEXT,
          started_at DATETIME NOT NULL,
          last_prompt_at DATETIME,
          last_event_at DATETIME NOT NULL,
          ended_at DATETIME,
          end_reason TEXT
      );

      INSERT INTO pi_sessions_v5
        SELECT pi_session_id, role,
          CASE WHEN status = 'idle' THEN 'waiting_for_user' ELSE status END,
          runtime_instance_id, pid, session_file, cwd, agent_dir,
          model_provider, model_id, thinking_level,
          started_at, last_prompt_at, last_event_at, ended_at, end_reason
        FROM pi_sessions;

      DROP TABLE pi_sessions;
      ALTER TABLE pi_sessions_v5 RENAME TO pi_sessions;

      CREATE INDEX IF NOT EXISTS idx_pi_sessions_status ON pi_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_pi_sessions_role_status ON pi_sessions(role, status);
      CREATE INDEX IF NOT EXISTS idx_pi_sessions_last_event_at ON pi_sessions(last_event_at);

      INSERT OR IGNORE INTO schema_migrations(version) VALUES (5);
    `);

    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys=ON;");
  }
}

function applyV6Migration(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE;");

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL CHECK (source IN ('whatsapp', 'web', 'hook', 'cron', 'init', 'pi_outbound')),
          direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
          content TEXT NOT NULL,
          sender TEXT,
          workstream_id TEXT REFERENCES workstreams(id) ON DELETE SET NULL,
          metadata TEXT,
          created_at DATETIME NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_messages_source_created ON messages(source, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_workstream ON messages(workstream_id);

      INSERT OR IGNORE INTO schema_migrations(version) VALUES (6);
    `);

    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

function applyV7Migration(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE;");

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS health_flags (
          flag TEXT PRIMARY KEY,
          reason TEXT NOT NULL,
          set_at DATETIME NOT NULL DEFAULT (datetime('now')),
          expires_at DATETIME,
          cleared_at DATETIME
      );

      INSERT OR IGNORE INTO schema_migrations(version) VALUES (7);
    `);

    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

function applyV8Migration(db: DatabaseSync): void {
  // Add 'init' to the messages source CHECK constraint.
  // SQLite doesn't support ALTER CHECK — recreate the table.
  db.exec("PRAGMA foreign_keys=OFF;");
  db.exec("BEGIN IMMEDIATE;");

  try {
    db.exec(`
      CREATE TABLE messages_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL CHECK (source IN ('whatsapp', 'web', 'hook', 'cron', 'init', 'pi_outbound')),
          direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
          content TEXT NOT NULL,
          sender TEXT,
          workstream_id TEXT REFERENCES workstreams(id) ON DELETE SET NULL,
          metadata TEXT,
          created_at DATETIME NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO messages_new SELECT * FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_new RENAME TO messages;

      CREATE INDEX IF NOT EXISTS idx_messages_source_created ON messages(source, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_workstream ON messages(workstream_id);

      INSERT OR IGNORE INTO schema_migrations(version) VALUES (8);
    `);

    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
  db.exec("PRAGMA foreign_keys=ON;");
}

function applyV9Migration(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE;");

  try {
    db.exec(`
      ALTER TABLE pi_sessions ADD COLUMN workstream_id TEXT REFERENCES workstreams(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_pi_sessions_workstream ON pi_sessions(workstream_id);

      INSERT OR IGNORE INTO schema_migrations(version) VALUES (9);
    `);

    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

function applyV10Migration(db: DatabaseSync): void {
  // Drop launch_id from sessions; remove 'processed' from whatsapp_messages status CHECK.
  // SQLite doesn't support DROP COLUMN (pre-3.35) or ALTER CHECK — recreate both tables.
  db.exec("PRAGMA foreign_keys=OFF;");
  db.exec("BEGIN IMMEDIATE;");

  try {
    // 1. Recreate sessions without launch_id
    db.exec(`
      CREATE TABLE sessions_v10 (
          session_id TEXT PRIMARY KEY,
          tmux_session TEXT,
          cwd TEXT NOT NULL,
          project TEXT NOT NULL,
          project_label TEXT,
          model TEXT,
          permission_mode TEXT,
          source TEXT,
          status TEXT NOT NULL DEFAULT 'working'
            CHECK (status IN ('working', 'idle', 'stale', 'ended')),
          transcript_path TEXT,
          task_description TEXT,
          todoist_task_id TEXT,
          agent_managed BOOLEAN DEFAULT 0,
          session_end_reason TEXT,
          workstream_id TEXT REFERENCES workstreams(id) ON DELETE SET NULL,
          pi_session_id TEXT REFERENCES pi_sessions(pi_session_id) ON DELETE SET NULL,
          started_at DATETIME NOT NULL,
          ended_at DATETIME,
          last_event_at DATETIME NOT NULL,
          last_tool_started_at DATETIME
      );

      INSERT INTO sessions_v10
        SELECT session_id, tmux_session, cwd, project, project_label,
               model, permission_mode, source, status, transcript_path,
               task_description, todoist_task_id, agent_managed, session_end_reason,
               workstream_id, pi_session_id, started_at, ended_at,
               last_event_at, last_tool_started_at
        FROM sessions;

      DROP TABLE sessions;
      ALTER TABLE sessions_v10 RENAME TO sessions;

      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
      CREATE INDEX IF NOT EXISTS idx_sessions_last_event_at ON sessions(last_event_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_workstream ON sessions(workstream_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_pi_session ON sessions(pi_session_id);
    `);

    // 2. Recreate whatsapp_messages without 'processed' in CHECK
    db.exec(`
      CREATE TABLE whatsapp_messages_v10 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
          wa_message_id TEXT,
          remote_jid TEXT NOT NULL,
          body TEXT NOT NULL,
          context_ref TEXT,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'sent', 'delivered', 'failed')),
          error_message TEXT,
          created_at DATETIME NOT NULL DEFAULT (datetime('now')),
          processed_at DATETIME
      );

      INSERT INTO whatsapp_messages_v10
        SELECT * FROM whatsapp_messages WHERE status != 'processed';

      DROP TABLE whatsapp_messages;
      ALTER TABLE whatsapp_messages_v10 RENAME TO whatsapp_messages;

      CREATE INDEX IF NOT EXISTS idx_whatsapp_status_created ON whatsapp_messages(status, created_at);

      INSERT OR IGNORE INTO schema_migrations(version) VALUES (10);
    `);

    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys=ON;");
  }
}

/**
 * V11: Add 'agent' to messages source CHECK constraint.
 * SQLite CHECK constraints are part of the table definition, so we recreate the table.
 */
function applyV11Migration(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys=OFF;");
  db.exec("BEGIN IMMEDIATE;");

  try {
    db.exec(`
      CREATE TABLE messages_v11 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL CHECK (source IN ('whatsapp', 'web', 'hook', 'cron', 'init', 'agent', 'pi_outbound')),
          direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
          content TEXT NOT NULL,
          sender TEXT,
          workstream_id TEXT REFERENCES workstreams(id) ON DELETE SET NULL,
          metadata TEXT,
          created_at DATETIME NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO messages_v11 SELECT * FROM messages;

      DROP TABLE messages;
      ALTER TABLE messages_v11 RENAME TO messages;

      CREATE INDEX IF NOT EXISTS idx_messages_source_created ON messages(source, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_workstream ON messages(workstream_id);

      INSERT OR IGNORE INTO schema_migrations(version) VALUES (11);
    `);

    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys=ON;");
  }
}

export function migrateBlackboard(db: DatabaseSync): number {
  ensureMigrationsTable(db);

  let version = getSchemaVersion(db);
  if (version === 0) {
    // Fresh database — apply full schema at once
    applyFullSchema(db);
    db.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)").run(
      LATEST_BLACKBOARD_SCHEMA_VERSION,
    );
    return LATEST_BLACKBOARD_SCHEMA_VERSION;
  }

  if (hasLegacyMarkers(db)) {
    applyLegacyUpgrade(db);
    version = getSchemaVersion(db);
  }

  if (version < 4) {
    applyV4Migration(db);
    version = getSchemaVersion(db);
  }

  if (version < 5) {
    applyV5Migration(db);
    version = getSchemaVersion(db);
  }

  if (version < 6) {
    applyV6Migration(db);
    version = getSchemaVersion(db);
  }

  if (version < 7) {
    applyV7Migration(db);
    version = getSchemaVersion(db);
  }

  if (version < 8) {
    applyV8Migration(db);
    version = getSchemaVersion(db);
  }

  if (version < 9) {
    applyV9Migration(db);
    version = getSchemaVersion(db);
  }

  if (version < 10) {
    applyV10Migration(db);
  }

  return getSchemaVersion(db);
}
