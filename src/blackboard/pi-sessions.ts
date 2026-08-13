import path from "node:path";
import type { PiSessionStatus as PersistedPiSessionStatus } from "../contracts/index.ts";
import type { BlackboardDatabase } from "./db.ts";
import {
  closePiSession,
  reassociateOrphanedSessions as reassociateOrphanedSessionsWrite,
  touchPiSessionEvent,
  touchPiSessionPrompt,
  upsertPiSession as writePiSession,
  updatePiSessionModel as writePiSessionModel,
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
  sessionUser?: string | null;
};

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
    stream_id: input.streamId,
    session_user: input.sessionUser,
  });
}

export function replaceDefaultPiSession(
  db: BlackboardDatabase,
  input: UpsertPiSessionInput & { sessionUser: string | null },
  end: { status: "ended" | "crashed"; endedAt: string; endReason: string },
  sessionsDir: string,
): string[] {
  if (input.streamId || input.role !== "default") {
    throw new Error("Default Pi session replacement requires a non-stream default session");
  }
  const pathPrefix = `${path.resolve(sessionsDir)}${path.sep}`;
  const pathUpperBound = `${pathPrefix}\uffff`;
  db.exec("BEGIN IMMEDIATE;");
  try {
    const previousPiSessionIds = db
      .all<{ pi_session_id: string }>(
        `SELECT pi_session_id
         FROM pi_sessions
         WHERE role = 'default'
           AND stream_id IS NULL
           AND session_user IS ?
           AND pi_session_id != ?
           AND session_file >= ?
           AND session_file < ?`,
        input.sessionUser,
        input.piSessionId,
        pathPrefix,
        pathUpperBound,
      )
      .map((session) => session.pi_session_id);
    db.prepare(
      `UPDATE pi_sessions
       SET status = ?, ended_at = ?, end_reason = ?, last_event_at = MAX(last_event_at, ?)
       WHERE role = 'default'
         AND stream_id IS NULL
         AND session_user IS ?
         AND pi_session_id != ?
         AND status IN ('active', 'waiting_for_user', 'waiting_for_sessions')`,
    ).run(
      end.status,
      end.endedAt,
      end.endReason,
      end.endedAt,
      input.sessionUser,
      input.piSessionId,
    );
    upsertPiSession(db, input);
    db.prepare(
      "UPDATE pi_sessions SET ended_at = NULL, end_reason = NULL WHERE pi_session_id = ?",
    ).run(input.piSessionId);
    db.exec("COMMIT;");
    return previousPiSessionIds;
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
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

export function updatePiSessionModelMirror(
  db: BlackboardDatabase,
  piSessionId: string,
  modelProvider: string,
  modelId: string,
  thinkingLevel: string,
): void {
  writePiSessionModel(
    db,
    piSessionId,
    modelProvider,
    modelId,
    thinkingLevel,
    new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  );
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
