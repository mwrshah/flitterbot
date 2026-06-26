import type { PiSessionStatus } from "../contracts/index.ts";
import type { BlackboardDatabase } from "./db.ts";

type PiSessionRecord = {
  pi_session_id: string;
  role: string;
  status?: PiSessionStatus;
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

export function upsertPiSession(db: BlackboardDatabase, session: PiSessionRecord): void {
  // session_user trickles 1:1 from the owning stream — single source of truth is streams.stream_user.
  const sessionUser = session.stream_id
    ? (db.get<{ stream_user: string | null }>(
        "SELECT stream_user FROM streams WHERE id = ?",
        session.stream_id,
      )?.stream_user ?? null)
    : null;
  db.prepare(
    `INSERT INTO pi_sessions (
       pi_session_id,
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
       session_user,
       last_datetime_reported_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(pi_session_id) DO UPDATE SET
       role = excluded.role,
       status = excluded.status,
       runtime_instance_id = COALESCE(excluded.runtime_instance_id, pi_sessions.runtime_instance_id),
       pid = COALESCE(excluded.pid, pi_sessions.pid),
       session_file = COALESCE(excluded.session_file, pi_sessions.session_file),
       cwd = excluded.cwd,
       agent_dir = COALESCE(excluded.agent_dir, pi_sessions.agent_dir),
       model_provider = COALESCE(excluded.model_provider, pi_sessions.model_provider),
       model_id = COALESCE(excluded.model_id, pi_sessions.model_id),
       thinking_level = COALESCE(excluded.thinking_level, pi_sessions.thinking_level),
       started_at = MIN(pi_sessions.started_at, excluded.started_at),
       last_prompt_at = COALESCE(excluded.last_prompt_at, pi_sessions.last_prompt_at),
       last_event_at = MAX(pi_sessions.last_event_at, excluded.last_event_at),
       ended_at = COALESCE(excluded.ended_at, pi_sessions.ended_at),
       end_reason = COALESCE(excluded.end_reason, pi_sessions.end_reason),
       stream_id = COALESCE(excluded.stream_id, pi_sessions.stream_id),
       session_user = COALESCE(excluded.session_user, pi_sessions.session_user),
       last_datetime_reported_at = COALESCE(pi_sessions.last_datetime_reported_at, excluded.last_datetime_reported_at)`,
  ).run(
    session.pi_session_id,
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
    sessionUser,
    session.started_at,
  );
}

export function markPreviousPiSessionsInactive(
  db: BlackboardDatabase,
  options: {
    role: string;
    runtimeInstanceId?: string;
    endedAt: string;
    endReason: string;
    status?: Extract<PiSessionStatus, "ended" | "crashed">;
  },
): number {
  const result = db
    .prepare(
      `UPDATE pi_sessions
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

export function touchPiSessionPrompt(
  db: BlackboardDatabase,
  piSessionId: string,
  timestamp: string,
  status: Extract<
    PiSessionStatus,
    "active" | "waiting_for_user" | "waiting_for_sessions"
  > = "active",
): void {
  db.prepare(
    `UPDATE pi_sessions
     SET last_prompt_at = ?,
         last_event_at = MAX(last_event_at, ?),
         status = ?,
         ended_at = NULL,
         end_reason = NULL
     WHERE pi_session_id = ?`,
  ).run(timestamp, timestamp, status, piSessionId);
}

export function touchPiSessionEvent(
  db: BlackboardDatabase,
  piSessionId: string,
  timestamp: string,
  status: Extract<
    PiSessionStatus,
    "active" | "waiting_for_user" | "waiting_for_sessions"
  > = "active",
): void {
  db.prepare(
    `UPDATE pi_sessions
     SET last_event_at = MAX(last_event_at, ?),
         status = ?,
         ended_at = NULL,
         end_reason = NULL
     WHERE pi_session_id = ?`,
  ).run(timestamp, status, piSessionId);
}

export function updatePiSessionModel(
  db: BlackboardDatabase,
  piSessionId: string,
  modelProvider: string,
  modelId: string,
  thinkingLevel: string,
  timestamp: string,
): void {
  db.prepare(
    `UPDATE pi_sessions
     SET model_provider = ?,
         model_id = ?,
         thinking_level = ?,
         last_event_at = MAX(last_event_at, ?)
     WHERE pi_session_id = ?`,
  ).run(modelProvider, modelId, thinkingLevel, timestamp, piSessionId);
}

export function reassociateOrphanedSessions(
  db: BlackboardDatabase,
  newPiSessionId: string,
): number {
  const result = db
    .prepare(
      `UPDATE sessions
       SET pi_session_id = ?,
           tmux_session = NULL
       WHERE status NOT IN ('ended')
         AND pi_session_id IS NOT NULL
         AND pi_session_id != ?
         AND pi_session_id IN (
           SELECT pi_session_id FROM pi_sessions WHERE status IN ('ended', 'crashed')
         )`,
    )
    .run(newPiSessionId, newPiSessionId);

  return Number(result.changes ?? 0);
}

export function closePiSession(
  db: BlackboardDatabase,
  piSessionId: string,
  options: {
    status?: Extract<PiSessionStatus, "ended" | "crashed">;
    endedAt: string;
    endReason: string;
  },
): void {
  db.prepare(
    `UPDATE pi_sessions
     SET status = ?,
         ended_at = ?,
         end_reason = ?,
         last_event_at = MAX(last_event_at, ?)
     WHERE pi_session_id = ?`,
  ).run(
    options.status ?? "ended",
    options.endedAt,
    options.endReason,
    options.endedAt,
    piSessionId,
  );
}
