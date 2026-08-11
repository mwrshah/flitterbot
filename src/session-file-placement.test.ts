import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { openBlackboard } from "./blackboard/db.ts";
import { reconcileStreamSessionFiles } from "./streams/session-file-placement.ts";

test("reconciliation hydrates a missing Pi session file without changing its identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flitterbot-session-hydration-"));
  const sessionsDir = path.join(root, "sessions");
  const archivedSessionsDir = path.join(root, "archived-sessions");
  fs.mkdirSync(sessionsDir);
  fs.mkdirSync(archivedSessionsDir);
  const blackboard = openBlackboard(path.join(root, "blackboard.db"));

  try {
    const streamId = "stream-1";
    const piSessionId = "019e91f2-5b5d-7fe2-ab9f-9321f22b8c99";
    const cwd = "/tmp/original-project";
    const startedAt = "2026-06-04T09:24:00.023Z";
    const basename = `2026-06-04T09-23-59-965Z_${piSessionId}.jsonl`;
    const missingSessionFile = path.join(sessionsDir, basename);
    const hydratedSessionFile = path.join(archivedSessionsDir, basename);

    blackboard.run(
      "INSERT INTO streams (id, name, status, pinned) VALUES (?, ?, 'closed', 0)",
      streamId,
      "missing-session-file",
    );
    blackboard.run(
      `INSERT INTO pi_sessions
         (pi_session_id, role, status, session_file, cwd, started_at, last_event_at, stream_id)
       VALUES (?, 'default', 'ended', ?, ?, ?, ?, ?)`,
      piSessionId,
      missingSessionFile,
      cwd,
      startedAt,
      startedAt,
      streamId,
    );

    const result = reconcileStreamSessionFiles(
      blackboard,
      streamId,
      sessionsDir,
      archivedSessionsDir,
    );

    assert.equal(result.file.status, "hydrated");
    assert.equal(result.file.sessionFile, hydratedSessionFile);
    assert.deepEqual(JSON.parse(fs.readFileSync(hydratedSessionFile, "utf8")), {
      type: "session",
      version: 3,
      id: piSessionId,
      timestamp: startedAt,
      cwd,
    });
    assert.equal(
      blackboard.get<{ session_file: string }>(
        "SELECT session_file FROM pi_sessions WHERE pi_session_id = ?",
        piSessionId,
      )?.session_file,
      hydratedSessionFile,
    );

    const restored = SessionManager.open(hydratedSessionFile, archivedSessionsDir);
    assert.equal(restored.getSessionId(), piSessionId);
    assert.equal(restored.getCwd(), cwd);
    assert.deepEqual(restored.getEntries(), []);

    const repeated = reconcileStreamSessionFiles(
      blackboard,
      streamId,
      sessionsDir,
      archivedSessionsDir,
    );
    assert.equal(repeated.file.status, "already-placed");
  } finally {
    blackboard.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
