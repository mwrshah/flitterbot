import type { AutonomaConfig } from "../config/load-config.ts";
import type {
  ClaudeSessionRow,
  ClaudeSessionListItem as SessionListItem,
} from "../contracts/index.ts";
import type { BlackboardDatabase } from "./db.ts";

export interface SessionStartPayload {
  session_id: string;
  cwd?: string;
  model?: string;
  permission_mode?: string;
  source?: string;
  transcript_path?: string;
  agent_managed?: boolean;
  tmux_session?: string;
  task_description?: string;
  todoist_task_id?: string;
  pi_session_id?: string;
  workstream_id?: string;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

function deriveProject(cwd: string | null | undefined): { project: string; projectLabel: string } {
  if (!cwd) return { project: "unknown", projectLabel: "unknown" };
  const label = cwd.split("/").filter(Boolean).pop() || cwd;
  return { project: label, projectLabel: label };
}

type InjectionEligibility =
  | { ok: true; reason: "idle" }
  | { ok: false; reason: "ended" | "no_tmux_session" | "busy" | "stale_or_ambiguous" };

function parseIsoTime(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function minutesAgo(now: number, value: string | null | undefined): number | null {
  const time = parseIsoTime(value);
  if (time === null) {
    return null;
  }
  return (now - time) / 60_000;
}

function mapSessionRow(row: ClaudeSessionRow): SessionListItem {
  return {
    sessionId: row.session_id,
    tmuxSession: row.tmux_session,
    cwd: row.cwd,
    project: row.project,
    projectLabel: row.project_label,
    model: row.model,
    permissionMode: row.permission_mode,
    source: row.source,
    status: row.status,
    transcriptPath: row.transcript_path,
    taskDescription: row.task_description,
    todoistTaskId: row.todoist_task_id,
    agentManaged: Boolean(row.agent_managed),
    sessionEndReason: row.session_end_reason,
    workstreamId: row.workstream_id,
    piSessionId: row.pi_session_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    lastEventAt: row.last_event_at,
    lastToolStartedAt: row.last_tool_started_at,
  };
}

export function listSessions(db: BlackboardDatabase): SessionListItem[] {
  const rows = db
    .prepare(
      `SELECT *
       FROM sessions
       ORDER BY
         CASE status
           WHEN 'working' THEN 0
           WHEN 'idle' THEN 1
           WHEN 'stale' THEN 2
           ELSE 3
         END,
         last_event_at DESC`,
    )
    .all() as unknown as ClaudeSessionRow[];

  return rows.map(mapSessionRow);
}

export function getSessionById(db: BlackboardDatabase, sessionId: string): SessionListItem | null {
  const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as unknown as
    | ClaudeSessionRow
    | undefined;
  return row ? mapSessionRow(row) : null;
}

export function getSessionByTmuxSession(
  db: BlackboardDatabase,
  tmuxSession: string,
): SessionListItem | null {
  const row = db
    .prepare(
      `SELECT *
       FROM sessions
       WHERE tmux_session = ?
       ORDER BY last_event_at DESC
       LIMIT 1`,
    )
    .get(tmuxSession) as unknown as ClaudeSessionRow | undefined;

  return row ? mapSessionRow(row) : null;
}

export function getInjectionEligibility(
  session: SessionListItem,
  config: Pick<AutonomaConfig, "stallMinutes" | "toolTimeoutMinutes">,
): InjectionEligibility {
  if (session.status === "ended") {
    return { ok: false, reason: "ended" };
  }

  if (!session.tmuxSession) {
    return { ok: false, reason: "no_tmux_session" };
  }

  if (session.status === "stale") {
    return { ok: false, reason: "stale_or_ambiguous" };
  }

  if (session.status === "idle") {
    return { ok: true, reason: "idle" };
  }

  const now = Date.now();
  const lastEventAgeMinutes = minutesAgo(now, session.lastEventAt);
  const lastToolAgeMinutes = minutesAgo(now, session.lastToolStartedAt);
  const staleByEvent = lastEventAgeMinutes === null || lastEventAgeMinutes > config.stallMinutes;
  const staleByTool =
    session.lastToolStartedAt === null
      ? true
      : lastToolAgeMinutes !== null && lastToolAgeMinutes > config.toolTimeoutMinutes;

  if (!staleByEvent) {
    return { ok: false, reason: "busy" };
  }

  if (staleByEvent && staleByTool) {
    return { ok: false, reason: "stale_or_ambiguous" };
  }

  return { ok: false, reason: "busy" };
}

function findStaleCandidates(
  db: BlackboardDatabase,
  stallMinutes: number,
  toolTimeoutMinutes: number,
): SessionListItem[] {
  const rows = db
    .prepare(
      `SELECT *
       FROM sessions
       WHERE status = 'working'
         AND datetime(last_event_at) <= datetime('now', '-' || ? || ' minutes')
         AND (
           last_tool_started_at IS NULL
           OR datetime(last_tool_started_at) <= datetime('now', '-' || ? || ' minutes')
         )
       ORDER BY last_event_at ASC`,
    )
    .all(stallMinutes, toolTimeoutMinutes) as unknown as ClaudeSessionRow[];
  return rows.map(mapSessionRow);
}

export function markStaleSessions(
  db: BlackboardDatabase,
  stallMinutes: number,
  toolTimeoutMinutes: number,
): SessionListItem[] {
  const candidates = findStaleCandidates(db, stallMinutes, toolTimeoutMinutes);
  for (const session of candidates) {
    db.prepare(
      `UPDATE sessions SET status = 'stale' WHERE session_id = ? AND status = 'working'`,
    ).run(session.sessionId);
  }
  return candidates;
}

export function findIdleCleanupCandidates(
  db: BlackboardDatabase,
  idleBeforeIsoOrHours: string | number,
): SessionListItem[] {
  let rows: ClaudeSessionRow[];
  if (typeof idleBeforeIsoOrHours === "string") {
    rows = db
      .prepare(
        `SELECT *
         FROM sessions
         WHERE status IN ('working', 'stale')
           AND last_event_at < ?
         ORDER BY last_event_at ASC`,
      )
      .all(idleBeforeIsoOrHours) as unknown as ClaudeSessionRow[];
  } else {
    rows = db
      .prepare(
        `SELECT *
         FROM sessions
         WHERE status IN ('working', 'stale')
           AND datetime(last_event_at) <= datetime('now', '-' || ? || ' hours')
         ORDER BY last_event_at ASC`,
      )
      .all(idleBeforeIsoOrHours) as unknown as ClaudeSessionRow[];
  }
  return rows.map(mapSessionRow);
}

export function markSessionEnded(
  db: BlackboardDatabase,
  sessionId: string,
  reason: string,
  endedAt = new Date().toISOString(),
): void {
  db.prepare(
    `UPDATE sessions
     SET status = 'ended',
         session_end_reason = ?,
         ended_at = COALESCE(ended_at, ?),
         last_event_at = MAX(last_event_at, ?),
         last_tool_started_at = NULL
     WHERE session_id = ?`,
  ).run(reason, endedAt, endedAt, sessionId);
}

export function insertSession(db: BlackboardDatabase, payload: SessionStartPayload): void {
  const ts = nowIso();
  const cwd = textOrNull(payload.cwd) || ".";
  const { project, projectLabel } = deriveProject(cwd);

  db.prepare(
    `INSERT INTO sessions (
       session_id, launch_id, tmux_session, cwd, project, project_label,
       model, permission_mode, source, status, transcript_path,
       task_description, todoist_task_id, agent_managed,
       pi_session_id, workstream_id, started_at, last_event_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'working', ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       tmux_session = COALESCE(excluded.tmux_session, sessions.tmux_session),
       cwd = excluded.cwd,
       project = excluded.project,
       project_label = excluded.project_label,
       model = COALESCE(excluded.model, sessions.model),
       permission_mode = COALESCE(excluded.permission_mode, sessions.permission_mode),
       source = COALESCE(excluded.source, sessions.source),
       status = 'working',
       transcript_path = COALESCE(excluded.transcript_path, sessions.transcript_path),
       task_description = COALESCE(excluded.task_description, sessions.task_description),
       todoist_task_id = COALESCE(excluded.todoist_task_id, sessions.todoist_task_id),
       agent_managed = CASE
         WHEN excluded.agent_managed IS NOT NULL THEN excluded.agent_managed
         ELSE sessions.agent_managed
       END,
       pi_session_id = COALESCE(excluded.pi_session_id, sessions.pi_session_id),
       workstream_id = COALESCE(excluded.workstream_id, sessions.workstream_id),
       started_at = MIN(sessions.started_at, excluded.started_at),
       last_event_at = MAX(sessions.last_event_at, excluded.last_event_at)`,
  ).run(
    payload.session_id,
    null,
    textOrNull(payload.tmux_session),
    cwd,
    project,
    projectLabel,
    textOrNull(payload.model),
    textOrNull(payload.permission_mode),
    textOrNull(payload.source),
    textOrNull(payload.transcript_path),
    textOrNull(payload.task_description),
    textOrNull(payload.todoist_task_id),
    payload.agent_managed ? 1 : 0,
    textOrNull(payload.pi_session_id),
    textOrNull(payload.workstream_id),
    ts,
    ts,
  );
}

export function updateSessionStop(db: BlackboardDatabase, sessionId: string): void {
  const ts = nowIso();
  db.prepare(
    `UPDATE sessions
     SET last_event_at = MAX(last_event_at, ?),
         status = CASE
           WHEN status = 'ended' THEN status
           WHEN ? >= last_event_at THEN 'idle'
           ELSE status
         END
     WHERE session_id = ?`,
  ).run(ts, ts, sessionId);
}

export function getActiveManagedSessionsByPi(
  db: BlackboardDatabase,
  piSessionId: string,
): SessionListItem[] {
  const rows = db
    .prepare(
      `SELECT *
       FROM sessions
       WHERE pi_session_id = ?
         AND status IN ('working', 'idle')
         AND agent_managed = 1
       ORDER BY last_event_at DESC`,
    )
    .all(piSessionId) as unknown as ClaudeSessionRow[];
  return rows.map(mapSessionRow);
}

export function countActiveManagedSessionsByPi(
  db: BlackboardDatabase,
  piSessionId: string,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM sessions
       WHERE pi_session_id = ?
         AND status IN ('working', 'idle')
         AND agent_managed = 1`,
    )
    .get(piSessionId) as { count: number };
  return Number(row.count);
}
