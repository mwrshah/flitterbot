import type { PiSessionStatus as PersistedPiSessionStatus } from "../contracts/index.ts";
import type { BlackboardDatabase } from "./db.ts";
import {
  closePiSession,
  markPreviousPiSessionsInactive,
  reassociateOrphanedSessions as reassociateOrphanedSessionsWrite,
  touchPiSessionEvent,
  touchPiSessionPrompt,
  upsertPiSession as writePiSession,
} from "./write-pi-sessions.ts";

type UpsertPiSessionInput = {
  piSessionId: string;
  role: string;
  status?: PersistedPiSessionStatus;
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

export function reconcilePreviousPiSessions(
  db: BlackboardDatabase,
  role: string,
  runtimeInstanceId: string,
  reason: string = "replaced",
  status: Extract<PersistedPiSessionStatus, "ended" | "crashed"> = "ended",
): number {
  return markPreviousPiSessionsInactive(db, {
    role,
    runtimeInstanceId,
    endedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    endReason: reason,
    status,
  });
}

export function upsertPiSession(db: BlackboardDatabase, input: UpsertPiSessionInput): void {
  writePiSession(db, {
    pi_session_id: input.piSessionId,
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
    workstream_id: input.streamId,
  });
}

export function touchPiPrompt(
  db: BlackboardDatabase,
  piSessionId: string,
  timestamp: string,
  status: Extract<
    PersistedPiSessionStatus,
    "active" | "waiting_for_user" | "waiting_for_sessions"
  > = "active",
): void {
  touchPiSessionPrompt(db, piSessionId, timestamp, status);
}

export function touchPiEvent(
  db: BlackboardDatabase,
  piSessionId: string,
  timestamp: string,
  status: Extract<
    PersistedPiSessionStatus,
    "active" | "waiting_for_user" | "waiting_for_sessions"
  > = "active",
): void {
  touchPiSessionEvent(db, piSessionId, timestamp, status);
}

export function updatePiSessionStatus(
  db: BlackboardDatabase,
  piSessionId: string,
  status: PersistedPiSessionStatus,
): void {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  db.prepare(
    `UPDATE pi_sessions
     SET status = ?,
         last_event_at = MAX(last_event_at, ?)
     WHERE pi_session_id = ?`,
  ).run(status, now, piSessionId);
}

export function getLastDatetimeReportedAt(
  db: BlackboardDatabase,
  piSessionId: string,
): string | null {
  const row = db.get<{ last_datetime_reported_at: string | null }>(
    "SELECT last_datetime_reported_at FROM pi_sessions WHERE pi_session_id = ?",
    piSessionId,
  );
  return row?.last_datetime_reported_at ?? null;
}

export function touchDatetimeReportedAt(
  db: BlackboardDatabase,
  piSessionId: string,
  timestamp: string,
): void {
  db.prepare("UPDATE pi_sessions SET last_datetime_reported_at = ? WHERE pi_session_id = ?").run(
    timestamp,
    piSessionId,
  );
}

export function reassociateOrphanedSessions(
  db: BlackboardDatabase,
  newPiSessionId: string,
): number {
  return reassociateOrphanedSessionsWrite(db, newPiSessionId);
}

export function endPiSession(
  db: BlackboardDatabase,
  piSessionId: string,
  status: Extract<PersistedPiSessionStatus, "ended" | "crashed">,
  reason: string,
  endedAt: string = new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
): void {
  closePiSession(db, piSessionId, {
    status,
    endedAt,
    endReason: reason,
  });
}
