import type { StreamSessionStatus } from "../contracts/index.ts";
import type { BlackboardDatabase } from "./db.ts";

type StreamSessionRecord = {
  stream_session_id: string;
  role: string;
  status?: StreamSessionStatus;
  runtime_instance_id?: string;
  pid?: number;
  session_file?: string;
  cwd: string;
  agent_dir?: string;
  model_provider?: string;
  model_id?: string;
  thinking_level?: string;
  started_at: string;
  last_prompt_at?: string;
  last_event_at: string;
  ended_at?: string;
  end_reason?: string;
  stream_id?: string;
};

export function upsertStreamSession(db: BlackboardDatabase, session: StreamSessionRecord): void {
  db.prepare(
    `INSERT INTO stream_sessions (
       stream_session_id,
       role,
       status,
       runtime_instance_id,
       pid,
       session_file,
       cwd,
       agent_dir,
       model_provider,
       model_id,
       thinking_level,
       started_at,
       last_prompt_at,
       last_event_at,
       ended_at,
       end_reason,
       stream_id,
       last_datetime_reported_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(stream_session_id) DO UPDATE SET
       role = excluded.role,
       status = excluded.status,
       runtime_instance_id = COALESCE(excluded.runtime_instance_id, stream_sessions.runtime_instance_id),
       pid = COALESCE(excluded.pid, stream_sessions.pid),
       session_file = COALESCE(excluded.session_file, stream_sessions.session_file),
       cwd = excluded.cwd,
       agent_dir = COALESCE(excluded.agent_dir, stream_sessions.agent_dir),
       model_provider = COALESCE(excluded.model_provider, stream_sessions.model_provider),
       model_id = COALESCE(excluded.model_id, stream_sessions.model_id),
       thinking_level = COALESCE(excluded.thinking_level, stream_sessions.thinking_level),
       started_at = MIN(stream_sessions.started_at, excluded.started_at),
       last_prompt_at = COALESCE(excluded.last_prompt_at, stream_sessions.last_prompt_at),
       last_event_at = MAX(stream_sessions.last_event_at, excluded.last_event_at),
       ended_at = COALESCE(excluded.ended_at, stream_sessions.ended_at),
       end_reason = COALESCE(excluded.end_reason, stream_sessions.end_reason),
       stream_id = COALESCE(excluded.stream_id, stream_sessions.stream_id),
       last_datetime_reported_at = COALESCE(stream_sessions.last_datetime_reported_at, excluded.last_datetime_reported_at)`,
  ).run(
    session.stream_session_id,
    session.role,
    session.status ?? "active",
    session.runtime_instance_id ?? null,
    session.pid ?? null,
    session.session_file ?? null,
    session.cwd,
    session.agent_dir ?? null,
    session.model_provider ?? null,
    session.model_id ?? null,
    session.thinking_level ?? null,
    session.started_at,
    session.last_prompt_at ?? null,
    session.last_event_at,
    session.ended_at ?? null,
    session.end_reason ?? null,
    session.stream_id ?? null,
    session.started_at,
  );
}

export function markPreviousStreamSessionsInactive(
  db: BlackboardDatabase,
  options: {
    role: string;
    runtimeInstanceId?: string;
    endedAt: string;
    endReason: string;
    status?: Extract<StreamSessionStatus, "ended" | "crashed">;
  },
): number {
  const result = db
    .prepare(
      `UPDATE stream_sessions
     SET status = ?,
         ended_at = ?,
         end_reason = ?,
         last_event_at = MAX(last_event_at, ?)
     WHERE role = ?
       AND status IN ('active', 'waiting_for_user', 'waiting_for_sessions')
       AND (? IS NULL OR runtime_instance_id != ?)`,
    )
    .run(
      options.status ?? "ended",
      options.endedAt,
      options.endReason,
      options.endedAt,
      options.role,
      options.runtimeInstanceId ?? null,
      options.runtimeInstanceId ?? null,
    );

  return Number(result.changes ?? 0);
}

export function touchStreamSessionPrompt(
  db: BlackboardDatabase,
  streamSessionId: string,
  timestamp: string,
  status: Extract<
    StreamSessionStatus,
    "active" | "waiting_for_user" | "waiting_for_sessions"
  > = "active",
): void {
  db.prepare(
    `UPDATE stream_sessions
     SET last_prompt_at = ?,
         last_event_at = MAX(last_event_at, ?),
         status = ?,
         ended_at = NULL,
         end_reason = NULL
     WHERE stream_session_id = ?`,
  ).run(timestamp, timestamp, status, streamSessionId);
}

export function touchStreamSessionEvent(
  db: BlackboardDatabase,
  streamSessionId: string,
  timestamp: string,
  status: Extract<
    StreamSessionStatus,
    "active" | "waiting_for_user" | "waiting_for_sessions"
  > = "active",
): void {
  db.prepare(
    `UPDATE stream_sessions
     SET last_event_at = MAX(last_event_at, ?),
         status = ?,
         ended_at = NULL,
         end_reason = NULL
     WHERE stream_session_id = ?`,
  ).run(timestamp, status, streamSessionId);
}

/**
 * Re-associate orphaned sessions whose stream_session_id points to an ended streams session.
 * Moves them to the given new (active) streams session.
 */
export function reassociateOrphanedSessions(
  db: BlackboardDatabase,
  newStreamSessionId: string,
): number {
  const result = db
    .prepare(
      `UPDATE sessions
       SET stream_session_id = ?,
           tmux_session = NULL
       WHERE status NOT IN ('ended')
         AND stream_session_id IS NOT NULL
         AND stream_session_id != ?
         AND stream_session_id IN (
           SELECT stream_session_id FROM stream_sessions WHERE status IN ('ended', 'crashed')
         )`,
    )
    .run(newStreamSessionId, newStreamSessionId);

  return Number(result.changes ?? 0);
}

export function closeStreamSession(
  db: BlackboardDatabase,
  streamSessionId: string,
  options: {
    status?: Extract<StreamSessionStatus, "ended" | "crashed">;
    endedAt: string;
    endReason: string;
  },
): void {
  db.prepare(
    `UPDATE stream_sessions
     SET status = ?,
         ended_at = ?,
         end_reason = ?,
         last_event_at = MAX(last_event_at, ?)
     WHERE stream_session_id = ?`,
  ).run(
    options.status ?? "ended",
    options.endedAt,
    options.endReason,
    options.endedAt,
    streamSessionId,
  );
}
