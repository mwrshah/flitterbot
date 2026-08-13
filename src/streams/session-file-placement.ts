import fs from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION, type SessionHeader } from "@earendil-works/pi-coding-agent";
import type { BlackboardDatabase } from "../blackboard/db.ts";
import { updatePiSessionFile } from "../blackboard/write-pi-sessions.ts";

export type SessionFilePlacement = "active" | "archived";

export type SessionFileRecord = {
  piSessionId: string;
  sessionFile: string | null;
};

type MaterializedSessionFileRecord = SessionFileRecord & {
  cwd: string;
  startedAt: string;
};

type SessionFilePlacementStatus = "already-placed" | "hydrated" | "missing" | "moved" | "recovered";

type SessionFilePlacementResult = {
  piSessionId: string;
  previousSessionFile: string | null;
  sessionFile: string | null;
  status: SessionFilePlacementStatus;
};

type SessionFileReconciliationResult = {
  streamId: string;
  placement: SessionFilePlacement;
  file: SessionFilePlacementResult;
};

type StreamPlacementRow = {
  id: string;
  status: "open" | "closed";
  pinned: number | boolean;
};

type PiSessionFileRow = {
  pi_session_id: string;
  session_file: string | null;
  cwd: string;
  started_at: string;
};

type ManagedSessionPaths = {
  active: string;
  archived: string;
};

export type SessionFileTopology =
  | { kind: "unmaterialized"; physicalPath: null; paths: null }
  | { kind: "missing"; physicalPath: null; paths: ManagedSessionPaths }
  | {
      kind: "active-only" | "archived-only" | "same-inode";
      physicalPath: string;
      paths: ManagedSessionPaths;
    };

function resolveManagedDirectories(
  sessionsDir: string,
  archivedSessionsDir: string,
): ManagedSessionPaths {
  const active = path.resolve(sessionsDir);
  const archived = path.resolve(archivedSessionsDir);
  if (active === archived || path.dirname(active) !== path.dirname(archived)) {
    throw new Error(`Session file directories must be distinct siblings: ${active}, ${archived}`);
  }
  return { active, archived };
}

function resolveSessionPaths(
  record: SessionFileRecord,
  managedDirectories: ManagedSessionPaths,
): ManagedSessionPaths {
  const sessionFile = path.resolve(record.sessionFile!);
  const containingDirectory = path.dirname(sessionFile);
  if (
    containingDirectory !== managedDirectories.active &&
    containingDirectory !== managedDirectories.archived
  ) {
    throw new Error(
      `Refusing to relocate unmanaged session file for Pi session ${record.piSessionId}: ${record.sessionFile}`,
    );
  }

  const basename = path.basename(sessionFile);
  return {
    active: path.join(managedDirectories.active, basename),
    archived: path.join(managedDirectories.archived, basename),
  };
}

function sessionFileExists(filePath: string, piSessionId: string): boolean {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isFile()) return true;
    throw new Error(
      `Managed session path is not a regular file for Pi session ${piSessionId}: ${filePath}`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function classifySessionFileTopology(
  record: SessionFileRecord,
  sessionsDir: string,
  archivedSessionsDir: string,
): SessionFileTopology {
  if (record.sessionFile === null) {
    return { kind: "unmaterialized", physicalPath: null, paths: null };
  }
  const managedDirectories = resolveManagedDirectories(sessionsDir, archivedSessionsDir);
  const paths = resolveSessionPaths(record, managedDirectories);
  const activeExists = sessionFileExists(paths.active, record.piSessionId);
  const archivedExists = sessionFileExists(paths.archived, record.piSessionId);
  if (!activeExists && !archivedExists) return { kind: "missing", physicalPath: null, paths };
  if (activeExists && archivedExists) {
    const activeStat = fs.lstatSync(paths.active);
    const archivedStat = fs.lstatSync(paths.archived);
    if (activeStat.dev !== archivedStat.dev || activeStat.ino !== archivedStat.ino) {
      throw new Error(
        `Refusing to overwrite conflicting session files for Pi session ${record.piSessionId}: ${paths.active}, ${paths.archived}`,
      );
    }
    return { kind: "same-inode", physicalPath: path.resolve(record.sessionFile), paths };
  }
  return activeExists
    ? { kind: "active-only", physicalPath: paths.active, paths }
    : { kind: "archived-only", physicalPath: paths.archived, paths };
}

function updateSessionFile(
  blackboard: BlackboardDatabase,
  record: SessionFileRecord,
  sessionFile: string,
): void {
  updatePiSessionFile(blackboard, record.piSessionId, sessionFile);
}

function hydrateSessionFile(record: MaterializedSessionFileRecord, sessionFile: string): void {
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: record.piSessionId,
    timestamp: record.startedAt,
    cwd: record.cwd,
  } satisfies SessionHeader;
  fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function placeSessionFile(
  blackboard: BlackboardDatabase,
  record: MaterializedSessionFileRecord,
  placement: SessionFilePlacement,
  sessionsDir: string,
  archivedSessionsDir: string,
  hydrateMissing: boolean,
): SessionFilePlacementResult {
  if (record.sessionFile === null) {
    throw new Error(`Pi session ${record.piSessionId} has no materialized session file`);
  }

  const topology = classifySessionFileTopology(record, sessionsDir, archivedSessionsDir);
  if (!topology.paths) throw new Error(`Missing paths for Pi session ${record.piSessionId}`);
  const sessionPaths = topology.paths;
  const desiredPath = sessionPaths[placement];
  const otherPath = placement === "active" ? sessionPaths.archived : sessionPaths.active;
  const desiredExists =
    topology.kind === "same-inode" ||
    topology.kind === (placement === "active" ? "active-only" : "archived-only");
  const otherExists =
    topology.kind === "same-inode" ||
    topology.kind === (placement === "active" ? "archived-only" : "active-only");

  if (topology.kind === "same-inode") {
    fs.unlinkSync(otherPath);
    updateSessionFile(blackboard, record, desiredPath);
    return {
      piSessionId: record.piSessionId,
      previousSessionFile: record.sessionFile,
      sessionFile: desiredPath,
      status: "recovered",
    };
  }

  if (desiredExists) {
    if (record.sessionFile !== desiredPath) updateSessionFile(blackboard, record, desiredPath);
    return {
      piSessionId: record.piSessionId,
      previousSessionFile: record.sessionFile,
      sessionFile: desiredPath,
      status: record.sessionFile === desiredPath ? "already-placed" : "recovered",
    };
  }

  if (!otherExists) {
    if (!hydrateMissing) {
      updateSessionFile(blackboard, record, desiredPath);
      return {
        piSessionId: record.piSessionId,
        previousSessionFile: record.sessionFile,
        sessionFile: desiredPath,
        status: "missing",
      };
    }
    hydrateSessionFile(record, desiredPath);
    updateSessionFile(blackboard, record, desiredPath);
    return {
      piSessionId: record.piSessionId,
      previousSessionFile: record.sessionFile,
      sessionFile: desiredPath,
      status: "hydrated",
    };
  }

  try {
    fs.linkSync(otherPath, desiredPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Refusing to overwrite session file for Pi session ${record.piSessionId}: ${desiredPath}`,
      );
    }
    throw error;
  }
  fs.unlinkSync(otherPath);
  updateSessionFile(blackboard, record, desiredPath);
  return {
    piSessionId: record.piSessionId,
    previousSessionFile: record.sessionFile,
    sessionFile: desiredPath,
    status: "moved",
  };
}

function placePiSessionRow(
  blackboard: BlackboardDatabase,
  row: PiSessionFileRow,
  placement: SessionFilePlacement,
  sessionsDir: string,
  archivedSessionsDir: string,
  hydrateMissing: boolean,
): SessionFilePlacementResult {
  return placeSessionFile(
    blackboard,
    {
      piSessionId: row.pi_session_id,
      sessionFile: row.session_file,
      cwd: row.cwd,
      startedAt: row.started_at,
    },
    placement,
    sessionsDir,
    archivedSessionsDir,
    hydrateMissing,
  );
}

export function reconcilePiSessionFile(
  blackboard: BlackboardDatabase,
  piSessionId: string,
  placement: SessionFilePlacement,
  sessionsDir: string,
  archivedSessionsDir: string,
  options: { hydrateMissing?: boolean } = {},
): SessionFilePlacementResult {
  const row = blackboard.get<PiSessionFileRow>(
    `SELECT pi_session_id, session_file, cwd, started_at
     FROM pi_sessions
     WHERE pi_session_id = ?`,
    piSessionId,
  );
  if (!row) throw new Error(`Cannot reconcile missing Pi session: ${piSessionId}`);
  return placePiSessionRow(
    blackboard,
    row,
    placement,
    sessionsDir,
    archivedSessionsDir,
    options.hydrateMissing ?? false,
  );
}

export function reconcileStreamSessionFiles(
  blackboard: BlackboardDatabase,
  streamId: string,
  sessionsDir: string,
  archivedSessionsDir: string,
): SessionFileReconciliationResult {
  const stream = blackboard.get<StreamPlacementRow>(
    "SELECT id, status, pinned FROM streams WHERE id = ?",
    streamId,
  );
  if (!stream) throw new Error(`Cannot reconcile session files for missing stream: ${streamId}`);

  const placement: SessionFilePlacement =
    stream.status === "open" || stream.pinned ? "active" : "archived";
  const row = blackboard.get<PiSessionFileRow>(
    `SELECT pi_session_id, session_file, cwd, started_at
     FROM pi_sessions
     WHERE stream_id = ?`,
    streamId,
  );
  if (!row) throw new Error(`Cannot reconcile stream without a Pi session: ${streamId}`);
  const file = placePiSessionRow(
    blackboard,
    row,
    placement,
    sessionsDir,
    archivedSessionsDir,
    true,
  );

  return { streamId, placement, file };
}

export function reconcileAllStreamSessionFiles(
  blackboard: BlackboardDatabase,
  sessionsDir: string,
  archivedSessionsDir: string,
): SessionFileReconciliationResult[] {
  const streams = blackboard.all<{ id: string }>("SELECT id FROM streams ORDER BY created_at, id");
  return streams.map(({ id }) =>
    reconcileStreamSessionFiles(blackboard, id, sessionsDir, archivedSessionsDir),
  );
}
