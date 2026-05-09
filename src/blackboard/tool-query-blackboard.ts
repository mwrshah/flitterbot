import type { BlackboardDatabase } from "./db.ts";

// ── Pre-built query modes ──────────────────────────────────────────────────

const MODES: Record<string, string> = {
  active_sessions: `
    SELECT s.session_id, s.tmux_session, s.project, s.status, s.started_at,
           s.last_event_at, s.task_description, w.name AS stream_name
    FROM sessions s
    LEFT JOIN streams w ON s.stream_id = w.id
    WHERE s.status IN ('working', 'idle')
    ORDER BY s.last_event_at DESC`,

  open_streams: `
    SELECT id, name, repo_path, worktree_path, base_branch, status, created_at
    FROM streams
    WHERE status = 'open'
    ORDER BY created_at DESC`,

  session_summary: `
    SELECT s.session_id, s.project, s.status, s.model, s.agent_managed,
           s.started_at, s.ended_at, s.task_description,
           p.role AS pi_role, p.status AS pi_status,
           w.name AS stream_name
    FROM sessions s
    LEFT JOIN pi_sessions p ON s.pi_session_id = p.pi_session_id
    LEFT JOIN streams w ON s.stream_id = w.id
    ORDER BY s.started_at DESC
    LIMIT 20`,

  schema: `
    SELECT m.name AS table_name, p.cid, p.name AS column_name,
           p.type, p.'notnull' AS not_null, p.dflt_value, p.pk
    FROM sqlite_master m
    JOIN pragma_table_info(m.name) p
    WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
    ORDER BY m.name, p.cid`,
};

// ── Schema description (embedded in tool description for LLM context) ──────

const SCHEMA_DESCRIPTION = `Run read-only SQL against the Flitterbot blackboard database (SQLite).

SCHEMA — every table, column, type, and key:

streams
  id TEXT PK, name TEXT, repo_path TEXT, worktree_path TEXT,
  base_branch TEXT (branch this stream was forked from; required for close_stream merge mode),
  status TEXT ('open'|'closed'), created_at DATETIME, closed_at TEXT

sessions
  session_id TEXT PK (NOT "id"), tmux_session TEXT, cwd TEXT, project TEXT,
  project_label TEXT, model TEXT, permission_mode TEXT, source TEXT,
  status TEXT ('working'|'idle'|'stale'|'ended'),
  transcript_path TEXT, task_description TEXT, todoist_task_id TEXT,
  agent_managed BOOLEAN, session_end_reason TEXT,
  stream_id TEXT FK→streams.id,
  pi_session_id TEXT FK→pi_sessions.pi_session_id,
  started_at DATETIME (NOT "created_at"), ended_at DATETIME,
  last_event_at DATETIME, last_tool_started_at DATETIME

pi_sessions
  pi_session_id TEXT PK, role TEXT, status TEXT ('active'|'waiting_for_user'|'waiting_for_sessions'|'ended'|'crashed'),
  runtime_instance_id TEXT, pid INTEGER, session_file TEXT, cwd TEXT,
  agent_dir TEXT, model_provider TEXT, model_id TEXT, thinking_level TEXT,
  started_at DATETIME, last_prompt_at DATETIME, last_event_at DATETIME,
  ended_at DATETIME, end_reason TEXT,
  stream_id TEXT FK→streams.id,
  last_datetime_reported_at DATETIME

pending_actions
  action_id TEXT PK, channel TEXT, context_ref TEXT, kind TEXT,
  prompt_text TEXT, related_session_id TEXT, related_todoist_task_id TEXT,
  status TEXT (default 'pending'), created_at DATETIME, resolved_at DATETIME,
  resolution_payload TEXT

messages
  id TEXT PK, source TEXT ('whatsapp'|'web'|'hook'|'cron'|'init'|'agent'|'stream_outbound'),
  direction TEXT ('inbound'|'outbound'), content TEXT, sender TEXT,
  stream_id TEXT FK→streams.id, metadata TEXT, created_at DATETIME,
  pi_session_id TEXT FK→pi_sessions.pi_session_id

health_flags
  flag TEXT PK, reason TEXT, set_at DATETIME, expires_at DATETIME, cleared_at DATETIME

whatsapp_messages
  id INTEGER PK, direction TEXT ('inbound'|'outbound'), wa_message_id TEXT,
  remote_jid TEXT, body TEXT, context_ref TEXT,
  status TEXT ('pending'|'sent'|'delivered'|'failed'), error_message TEXT,
  created_at DATETIME, processed_at DATETIME

message_id_map
  server_id TEXT PK, agent_id TEXT, pi_session_id TEXT, created_at DATETIME

schema_migrations
  version INTEGER PK, applied_at DATETIME

KEY RELATIONSHIPS:
  sessions.stream_id → streams.id
  sessions.pi_session_id → pi_sessions.pi_session_id
  pi_sessions.stream_id → streams.id
  messages.stream_id → streams.id
  messages.pi_session_id → pi_sessions.pi_session_id

COMMON GOTCHAS:
  - sessions PK is "session_id", NOT "id"
  - sessions uses "started_at", NOT "created_at"
  - streams has no "session_id" column; join via sessions.stream_id
  - pi_sessions PK is "pi_session_id", NOT "id"

PARAMETERS:
  - sql: raw SELECT or PRAGMA statement (required when mode is omitted)
  - mode: optional shortcut — one of: active_sessions, open_streams, session_summary, schema
    When mode is provided, sql is ignored.`;

// ── Execution logic ────────────────────────────────────────────────────────

function executeQuery(
  db: BlackboardDatabase,
  sql: string | undefined,
  mode: string | undefined,
): Array<Record<string, unknown>> {
  let query: string;

  if (mode) {
    const built = MODES[mode];
    if (!built) {
      throw new Error(`Unknown mode "${mode}". Valid modes: ${Object.keys(MODES).join(", ")}`);
    }
    query = built.trim();
  } else {
    const normalized = String(sql ?? "")
      .trim()
      .replace(/;+\s*$/, "");
    if (!normalized) throw new Error("Either sql or mode is required");
    if (!/^(select|pragma)\b/i.test(normalized)) {
      throw new Error("query_blackboard only allows SELECT and PRAGMA");
    }
    if (normalized.includes(";")) {
      throw new Error("multiple SQL statements are not allowed");
    }
    query = normalized;
  }

  return db.prepare(query).all() as Array<Record<string, unknown>>;
}

// ── Tool definition factory ────────────────────────────────────────────────

export interface QueryBlackboardTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details?: unknown;
  }>;
}

export function createQueryBlackboardTool(db: BlackboardDatabase): QueryBlackboardTool {
  return {
    name: "query_blackboard",
    label: "Query Blackboard",
    description: SCHEMA_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        sql: { type: "string", description: "SELECT or PRAGMA SQL statement" },
        mode: {
          type: "string",
          enum: Object.keys(MODES),
          description:
            "Pre-built query shortcut. When provided, sql is ignored. Options: active_sessions, open_streams, session_summary, schema",
        },
      },
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        const rows = executeQuery(
          db,
          params.sql as string | undefined,
          params.mode as string | undefined,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
          details: rows,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  };
}
