import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { insertSession, markSessionEnded } from "../blackboard/query-sessions.ts";
import type { ClaudeHookPayload, HookResponse } from "../contracts/index.ts";
import type { CloudStore } from "./store.ts";

export async function receiveCloudHook(
  store: CloudStore,
  directory: string,
  streamId: string,
  generation: number,
  body: Record<string, unknown>,
  handleHook: (event: string, payload: ClaudeHookPayload) => HookResponse,
) {
  if (
    !Number.isSafeInteger(body.version) ||
    Number(body.version) < 1 ||
    !["session-start", "stop", "session-end", "snapshot"].includes(String(body.event))
  )
    throw new Error("Valid hook event and version required");
  if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload))
    throw new Error("Hook payload required");
  const input = body.payload as Record<string, unknown>;
  const sessionId = String(input.session_id ?? input.sessionId ?? "");
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId))
    throw new Error("Invalid downstream session identity");
  if (store.db.get("SELECT 1 FROM pi_sessions WHERE pi_session_id = ?", sessionId))
    throw new Error("Downstream identity collides with Pi");
  if (
    store.db.get(
      "SELECT 1 FROM cloud_hook_receipts WHERE stream_id = ? AND generation = ? AND version = ?",
      streamId,
      generation,
      Number(body.version),
    )
  )
    return { ok: true, duplicate: true };
  const existing = store.db.get<{ stream_id: string | null; transcript_path: string | null }>(
    "SELECT stream_id, transcript_path FROM sessions WHERE session_id = ?",
    sessionId,
  );
  if (existing && existing.stream_id !== streamId)
    throw new Error("Downstream belongs to another stream");
  const owner = store.db.get<{ pi_session_id: string }>(
    "SELECT pi_session_id FROM pi_sessions WHERE stream_id = ?",
    streamId,
  );
  if (!owner) throw new Error("Stream has no Pi owner");
  let transcript = existing?.transcript_path ?? undefined;
  if (typeof body.content === "string") {
    if (Buffer.byteLength(body.content) > 128 * 1024 * 1024)
      throw new Error("Transcript exceeds 128 MiB");
    const folder = path.join(directory, "cloud-transcripts", streamId);
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    transcript = path.join(folder, `${generation}-${body.version}-${sessionId}.jsonl`);
    const temporary = path.join(folder, `.${randomUUID()}`);
    try {
      const file = await fs.open(temporary, "wx", 0o600);
      try {
        await file.writeFile(body.content);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await fs.link(temporary, transcript);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "EEXIST" ||
          (await fs.readFile(transcript, "utf8")) !== body.content
        )
          throw error;
      }
      const dir = await fs.open(folder, "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  const worker = store.get(streamId);
  if (worker?.generation !== generation || worker.phase === "absent")
    throw new Error("Worker is superseded or closing");
  const payload: ClaudeHookPayload = {
    ...input,
    session_id: sessionId,
    pi_session_id: owner.pi_session_id,
    stream_id: streamId,
    agent_managed: true,
    transcript_path: transcript,
  };
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const event =
      worker.phase === "closing" && body.event === "stop" ? "session-end" : String(body.event);
    let result: HookResponse = { ok: true };
    if (event === "session-start" && worker.phase === "closing") {
      insertSession(store.db, {
        session_id: sessionId,
        stream_id: streamId,
        pi_session_id: owner.pi_session_id,
        agent_managed: true,
        transcript_path: transcript,
        cwd: payload.cwd,
      });
      markSessionEnded(store.db, sessionId, "stream_closing");
    } else if (event !== "snapshot") result = handleHook(event, payload);
    if (transcript)
      store.db.run(
        "UPDATE sessions SET transcript_path = ? WHERE session_id = ? AND stream_id = ?",
        transcript,
        sessionId,
        streamId,
      );
    store.db.run(
      "INSERT INTO cloud_hook_receipts (stream_id, generation, version, session_id) VALUES (?, ?, ?, ?)",
      streamId,
      generation,
      Number(body.version),
      sessionId,
    );
    store.db.exec("COMMIT");
    return result;
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}
