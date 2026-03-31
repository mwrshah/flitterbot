import type { StreamsSessionStatus as PersistedStreamsSessionStatus } from "../contracts/index.ts";
import type { BlackboardDatabase } from "./db.ts";
import {
  closeStreamsSession,
  markPreviousStreamsSessionsInactive,
  reassociateOrphanedSessions as reassociateOrphanedSessionsWrite,
  touchStreamsSessionEvent,
  touchStreamsSessionPrompt,
  upsertStreamsSession as writeStreamsSession,
} from "./write-streams-sessions.ts";

type UpsertStreamsSessionInput = {
  streamsSessionId: string;
  role: string;
  status?: PersistedStreamsSessionStatus;
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

export function reconcilePreviousStreamsSessions(
  db: BlackboardDatabase,
  role: string,
  runtimeInstanceId: string,
  reason: string = "replaced",
  status: Extract<PersistedStreamsSessionStatus, "ended" | "crashed"> = "ended",
): number {
  return markPreviousStreamsSessionsInactive(db, {
    role,
    runtimeInstanceId,
    endedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    endReason: reason,
    status,
  });
}

export function upsertStreamsSession(
  db: BlackboardDatabase,
  input: UpsertStreamsSessionInput,
): void {
  writeStreamsSession(db, {
    pi_session_id: input.streamsSessionId,
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
  streamsSessionId: string,
  timestamp: string,
  status: Extract<
    PersistedStreamsSessionStatus,
    "active" | "waiting_for_user" | "waiting_for_sessions"
  > = "active",
): void {
  touchStreamsSessionPrompt(db, streamsSessionId, timestamp, status);
}

export function touchStreamsEvent(
  db: BlackboardDatabase,
  streamsSessionId: string,
  timestamp: string,
  status: Extract<
    PersistedStreamsSessionStatus,
    "active" | "waiting_for_user" | "waiting_for_sessions"
  > = "active",
): void {
  touchStreamsSessionEvent(db, streamsSessionId, timestamp, status);
}

export function updateStreamsSessionStatus(
  db: BlackboardDatabase,
  streamsSessionId: string,
  status: PersistedStreamsSessionStatus,
): void {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  db.prepare(
    `UPDATE pi_sessions
     SET status = ?,
         last_event_at = MAX(last_event_at, ?)
     WHERE pi_session_id = ?`,
  ).run(status, now, streamsSessionId);
}

export function getLastDatetimeReportedAt(
  db: BlackboardDatabase,
  streamsSessionId: string,
): string | null {
  const row = db.get<{ last_datetime_reported_at: string | null }>(
    "SELECT last_datetime_reported_at FROM pi_sessions WHERE pi_session_id = ?",
    streamsSessionId,
  );
  return row?.last_datetime_reported_at ?? null;
}

export function touchDatetimeReportedAt(
  db: BlackboardDatabase,
  streamsSessionId: string,
  timestamp: string,
): void {
  db.prepare("UPDATE pi_sessions SET last_datetime_reported_at = ? WHERE pi_session_id = ?").run(
    timestamp,
    streamsSessionId,
  );
}

export function reassociateOrphanedSessions(
  db: BlackboardDatabase,
  newStreamsSessionId: string,
): number {
  return reassociateOrphanedSessionsWrite(db, newStreamsSessionId);
}

export function endStreamsSession(
  db: BlackboardDatabase,
  streamsSessionId: string,
  status: Extract<PersistedStreamsSessionStatus, "ended" | "crashed">,
  reason: string,
  endedAt: string = new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
): void {
  closeStreamsSession(db, streamsSessionId, {
    status,
    endedAt,
    endReason: reason,
  });
}
