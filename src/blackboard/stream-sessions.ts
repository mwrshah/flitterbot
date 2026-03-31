import type { StreamSessionStatus as PersistedStreamSessionStatus } from "../contracts/index.ts";
import type { BlackboardDatabase } from "./db.ts";
import {
  closeStreamSession,
  markPreviousStreamSessionsInactive,
  reassociateOrphanedSessions as reassociateOrphanedSessionsWrite,
  touchStreamSessionEvent,
  touchStreamSessionPrompt,
  upsertStreamSession as writeStreamSession,
} from "./write-stream-sessions.ts";

type UpsertStreamSessionInput = {
  streamSessionId: string;
  role: string;
  status?: PersistedStreamSessionStatus;
  runtimeInstanceId?: string;
  pid?: number;
  sessionFile?: string;
  cwd: string;
  agentDir?: string;
  modelProvider?: string;
  modelId?: string;
  thinkingLevel?: string;
  startedAt: string;
  lastEventAt: string;
  lastPromptAt?: string;
  streamId?: string;
};

export function reconcilePreviousStreamSessions(
  db: BlackboardDatabase,
  role: string,
  runtimeInstanceId: string,
  reason: string = "replaced",
  status: Extract<PersistedStreamSessionStatus, "ended" | "crashed"> = "ended",
): number {
  return markPreviousStreamSessionsInactive(db, {
    role,
    runtimeInstanceId,
    endedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    endReason: reason,
    status,
  });
}

export function upsertStreamSession(
  db: BlackboardDatabase,
  input: UpsertStreamSessionInput,
): void {
  writeStreamSession(db, {
    stream_session_id: input.streamSessionId,
    role: input.role,
    status: input.status ?? "active",
    runtime_instance_id: input.runtimeInstanceId,
    pid: input.pid,
    session_file: input.sessionFile,
    cwd: input.cwd,
    agent_dir: input.agentDir,
    model_provider: input.modelProvider,
    model_id: input.modelId,
    thinking_level: input.thinkingLevel,
    started_at: input.startedAt,
    last_prompt_at: input.lastPromptAt,
    last_event_at: input.lastEventAt,
    stream_id: input.streamId,
  });
}

export function touchStreamsPrompt(
  db: BlackboardDatabase,
  streamSessionId: string,
  timestamp: string,
  status: Extract<
    PersistedStreamSessionStatus,
    "active" | "waiting_for_user" | "waiting_for_sessions"
  > = "active",
): void {
  touchStreamSessionPrompt(db, streamSessionId, timestamp, status);
}

export function touchStreamsEvent(
  db: BlackboardDatabase,
  streamSessionId: string,
  timestamp: string,
  status: Extract<
    PersistedStreamSessionStatus,
    "active" | "waiting_for_user" | "waiting_for_sessions"
  > = "active",
): void {
  touchStreamSessionEvent(db, streamSessionId, timestamp, status);
}

export function updateStreamSessionStatus(
  db: BlackboardDatabase,
  streamSessionId: string,
  status: PersistedStreamSessionStatus,
): void {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  db.prepare(
    `UPDATE stream_sessions
     SET status = ?,
         last_event_at = MAX(last_event_at, ?)
     WHERE stream_session_id = ?`,
  ).run(status, now, streamSessionId);
}

export function getLastDatetimeReportedAt(
  db: BlackboardDatabase,
  streamSessionId: string,
): string | null {
  const row = db.get<{ last_datetime_reported_at: string | null }>(
    "SELECT last_datetime_reported_at FROM stream_sessions WHERE stream_session_id = ?",
    streamSessionId,
  );
  return row?.last_datetime_reported_at ?? null;
}

export function touchDatetimeReportedAt(
  db: BlackboardDatabase,
  streamSessionId: string,
  timestamp: string,
): void {
  db.prepare("UPDATE stream_sessions SET last_datetime_reported_at = ? WHERE stream_session_id = ?").run(
    timestamp,
    streamSessionId,
  );
}

export function reassociateOrphanedSessions(
  db: BlackboardDatabase,
  newStreamSessionId: string,
): number {
  return reassociateOrphanedSessionsWrite(db, newStreamSessionId);
}

export function endStreamSession(
  db: BlackboardDatabase,
  streamSessionId: string,
  status: Extract<PersistedStreamSessionStatus, "ended" | "crashed">,
  reason: string,
  endedAt: string = new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
): void {
  closeStreamSession(db, streamSessionId, {
    status,
    endedAt,
    endReason: reason,
  });
}
