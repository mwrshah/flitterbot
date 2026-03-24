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
  workstream_id?: string;
};

export function upsertPiSession(db: BlackboardDatabase, session: PiSessionRecord): void {
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
       workstream_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
       workstream_id = COALESCE(excluded.workstream_id, pi_sessions.workstream_id)`,
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
    session.workstream_id ?? null,
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
