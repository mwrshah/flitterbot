-- Autonoma blackboard schema (v11)
-- This file is the single source of truth for fresh database creation.
-- Keep in sync with BLACKBOARD_SCHEMA_SQL in src/contracts/blackboard.ts.
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workstreams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    repo_path TEXT,
    worktree_path TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    created_at DATETIME NOT NULL DEFAULT (datetime('now')),
    closed_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
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

CREATE TABLE IF NOT EXISTS pi_sessions (
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
    end_reason TEXT,
    workstream_id TEXT REFERENCES workstreams(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_pi_sessions_workstream ON pi_sessions(workstream_id);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
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

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL CHECK (source IN ('whatsapp', 'web', 'hook', 'cron', 'init', 'agent', 'pi_outbound')),
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    content TEXT NOT NULL,
    sender TEXT,
    workstream_id TEXT REFERENCES workstreams(id) ON DELETE SET NULL,
    metadata TEXT,
    created_at DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS health_flags (
    flag TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    set_at DATETIME NOT NULL DEFAULT (datetime('now')),
    expires_at DATETIME,
    cleared_at DATETIME
);

CREATE TABLE IF NOT EXISTS pending_actions (
    action_id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    context_ref TEXT,
    kind TEXT NOT NULL,
    prompt_text TEXT NOT NULL,
    related_session_id TEXT,
    related_todoist_task_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'resolved', 'expired', 'canceled')),
    created_at DATETIME NOT NULL DEFAULT (datetime('now')),
    resolved_at DATETIME,
    resolution_payload TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
CREATE INDEX IF NOT EXISTS idx_sessions_last_event_at ON sessions(last_event_at);
CREATE INDEX IF NOT EXISTS idx_sessions_workstream ON sessions(workstream_id);
CREATE INDEX IF NOT EXISTS idx_sessions_pi_session ON sessions(pi_session_id);
CREATE INDEX IF NOT EXISTS idx_workstreams_name ON workstreams(name);
CREATE INDEX IF NOT EXISTS idx_pi_sessions_status ON pi_sessions(status);
CREATE INDEX IF NOT EXISTS idx_pi_sessions_role_status ON pi_sessions(role, status);
CREATE INDEX IF NOT EXISTS idx_pi_sessions_last_event_at ON pi_sessions(last_event_at);
CREATE INDEX IF NOT EXISTS idx_whatsapp_status_created ON whatsapp_messages(status, created_at);
CREATE INDEX IF NOT EXISTS idx_pending_actions_status_created ON pending_actions(status, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_source_created ON messages(source, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_workstream ON messages(workstream_id);
