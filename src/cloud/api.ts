import type http from "node:http";
import path from "node:path";
import { getSessionById, listSessions } from "../blackboard/query-sessions.ts";
import { executeBlackboardQuery } from "../blackboard/tool-query-blackboard.ts";
import { isThinkingLevel } from "../config/load-config.ts";
import { sendJson } from "../routes/_shared.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { type Checkpoint, CheckpointStore } from "./checkpoints.ts";
import { receiveCloudHook } from "./hook-receiver.ts";
import { mergeCheckpoint } from "./merge.ts";
import { projectCheckpoint, serializePublication } from "./projection.ts";
import { CloudConflict, CloudStore } from "./store.ts";

export const CLOUD_API_PREFIX = "/internal/cloud/";
const MAX_REQUEST = 180 * 1024 * 1024;

type ApiRuntime = Pick<ControlSurfaceRuntime, "blackboard"> & {
  config: Pick<ControlSurfaceRuntime["config"], "controlSurfaceDir">;
  wsHub?: Pick<ControlSurfaceRuntime["wsHub"], "broadcast">;
  closeSwimlaneNoop?: ControlSurfaceRuntime["closeSwimlaneNoop"];
  handleHook?: ControlSurfaceRuntime["handleHook"];
  cloud?: Pick<NonNullable<ControlSurfaceRuntime["cloud"]>, "queueChanged"> | null;
};

export async function handleCloudApi(
  runtime: ApiRuntime,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith(CLOUD_API_PREFIX)) return false;
  const segments = url.pathname.slice(CLOUD_API_PREFIX.length).split("/");
  const [streamId, generationText, operation] = segments;
  if (
    segments.length !== 3 ||
    !streamId ||
    !generationText ||
    !operation ||
    !/^[1-9][0-9]*$/.test(generationText) ||
    !Number.isSafeInteger(Number(generationText))
  ) {
    sendJson(response, 400, { error: "Invalid cloud operation address" });
    return true;
  }
  const store = new CloudStore(runtime.blackboard);
  const generation = Number(generationText);
  const token = request.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
  try {
    if (!token) throw new CloudConflict("Worker authentication required");
    store.authenticate(streamId, generation, token);
  } catch {
    sendJson(response, 401, { error: "Invalid or superseded worker credentials" });
    return true;
  }
  response.setHeader("Cache-Control", "no-store");
  try {
    if (request.method === "GET" && operation === "sessions") {
      sendJson(response, 200, {
        sessions: listSessions(store.db).filter((session) => session.streamId === streamId),
      });
      return true;
    }
    if (request.method === "GET" && operation === "stream") {
      sendJson(response, 200, store.db.get("SELECT * FROM streams WHERE id = ?", streamId));
      return true;
    }
    if (request.method === "GET" && operation === "assignment") {
      const worker = store.get(streamId)!;
      sendJson(response, 200, {
        checkpointVersion: worker.checkpoint_version,
        phase: worker.phase,
      });
      return true;
    }
    if (request.method === "GET" && operation === "commands") {
      const commands = store.db.all<{ id: string; payload: string; created_at: string }>(
        "SELECT id, payload, created_at FROM cloud_commands WHERE stream_id = ? AND status = 'pending' ORDER BY created_at, id LIMIT 100",
        streamId,
      );
      sendJson(response, 200, {
        commands: commands.map((row) => ({
          id: row.id,
          createdAt: row.created_at,
          payload: JSON.parse(row.payload),
        })),
      });
      return true;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Unsupported cloud operation method" });
      return true;
    }
    const body = await readBody(
      request,
      ["checkpoint", "hook"].includes(operation) ? MAX_REQUEST : 1024 * 1024,
    );
    store.authenticate(streamId, generation, token!); // Upload may overlap worker replacement.
    switch (operation) {
      case "session": {
        if (typeof body.id !== "string") throw new Error("Session ID required");
        const session = getSessionById(store.db, body.id);
        if (session?.streamId !== streamId) throw new Error("Session is not owned by this worker");
        sendJson(response, 200, session);
        break;
      }
      case "hook": {
        if (!runtime.handleHook) throw new Error("Controller hook handler unavailable");
        const result = await serializePublication(store.db, streamId, () =>
          receiveCloudHook(
            store,
            runtime.config.controlSurfaceDir,
            streamId,
            generation,
            body,
            (event, payload) => runtime.handleHook!(event, payload),
          ),
        );
        runtime.wsHub?.broadcast({
          type: "status_changed",
          subsystem: "cloud-hook",
          timestamp: new Date().toISOString(),
        });
        sendJson(response, 200, result);
        break;
      }
      case "query": {
        const sql = typeof body.sql === "string" ? body.sql : undefined;
        const mode = typeof body.mode === "string" ? body.mode : undefined;
        const rows = executeBlackboardQuery(runtime.blackboard, sql, mode);
        sendJson(response, 200, { rows });
        break;
      }
      case "workspace": {
        if (typeof body.baseBranch !== "string" || !body.baseBranch.trim())
          throw new Error("Named merge target required");
        store.db.run("UPDATE streams SET base_branch = ? WHERE id = ?", body.baseBranch, streamId);
        sendJson(response, 200, { ok: true });
        break;
      }
      case "merge": {
        if (typeof body.baseBranch !== "string") throw new Error("Confirmed merge target required");
        sendJson(
          response,
          200,
          await mergeCheckpoint(store, streamId, generation, body.baseBranch),
        );
        break;
      }
      case "close": {
        if (!runtime.closeSwimlaneNoop) throw new Error("Controller close handler is unavailable");
        sendJson(response, 202, { ok: true, closing: true });
        setImmediate(() => {
          void runtime.closeSwimlaneNoop!(streamId).catch((error) =>
            runtime.wsHub?.broadcast({
              type: "error",
              message: `Cloud close failed: ${error instanceof Error ? error.message : String(error)}`,
            }),
          );
        });
        break;
      }
      case "cwd": {
        if (typeof body.cwd !== "string" || !path.isAbsolute(body.cwd))
          throw new Error("Absolute cwd required");
        store.db.run("UPDATE pi_sessions SET cwd = ? WHERE stream_id = ?", body.cwd, streamId);
        store.db.run("UPDATE streams SET worktree_path = NULL WHERE id = ?", streamId);
        runtime.wsHub?.broadcast({ type: "streams_changed", reason: "cwd_changed", streamId });
        sendJson(response, 200, { ok: true });
        break;
      }
      case "model": {
        if (
          typeof body.provider !== "string" ||
          typeof body.modelId !== "string" ||
          !isThinkingLevel(body.thinkingLevel)
        )
          throw new Error("Valid model and thinking level required");
        store.db.run(
          "UPDATE pi_sessions SET model_provider = ?, model_id = ?, thinking_level = ? WHERE stream_id = ? AND ended_at IS NULL",
          body.provider,
          body.modelId,
          body.thinkingLevel,
          streamId,
        );
        sendJson(response, 200, { ok: true });
        break;
      }
      case "state": {
        if (
          !["active", "waiting_for_user", "waiting_for_sessions"].includes(String(body.status)) ||
          typeof body.timestamp !== "string" ||
          !Number.isFinite(Date.parse(body.timestamp))
        ) {
          throw new Error("Valid session status and timestamp required");
        }
        const timestamp = new Date(body.timestamp).toISOString();
        store.db.run(
          `UPDATE pi_sessions SET status = ?, last_event_at = ?
          WHERE stream_id = ? AND ended_at IS NULL AND last_event_at <= ?`,
          body.status,
          timestamp,
          streamId,
          timestamp,
        );
        sendJson(response, 200, { ok: true });
        break;
      }
      case "restart": {
        store.db.run(
          "UPDATE cloud_commands SET status = 'uncertain', updated_at = ? WHERE stream_id = ? AND generation = ? AND status = 'accepted'",
          new Date().toISOString(),
          streamId,
          generation,
        );
        runtime.cloud?.queueChanged(streamId);
        sendJson(response, 200, { ok: true });
        break;
      }
      case "accept": {
        if (typeof body.id !== "string") throw new Error("Command ID required");
        const accepted = store.accept(streamId, generation, body.id);
        runtime.cloud?.queueChanged(streamId);
        sendJson(response, 200, { accepted });
        break;
      }
      case "fail": {
        if (typeof body.id !== "string") throw new Error("Command ID required");
        store.db.run(
          "UPDATE cloud_commands SET status = 'uncertain', updated_at = ? WHERE id = ? AND stream_id = ? AND generation = ? AND status = 'accepted'",
          new Date().toISOString(),
          body.id,
          streamId,
          generation,
        );
        runtime.cloud?.queueChanged(streamId);
        sendJson(response, 200, { ok: true });
        break;
      }
      case "complete": {
        if (typeof body.id !== "string") throw new Error("Command ID required");
        store.complete(streamId, generation, body.id);
        runtime.cloud?.queueChanged(streamId);
        sendJson(response, 200, { ok: true });
        break;
      }
      case "checkpoint": {
        const checkpoints = new CheckpointStore(
          store,
          path.join(runtime.config.controlSurfaceDir, "cloud-checkpoints"),
        );
        await serializePublication(runtime.blackboard, streamId, async () => {
          await checkpoints.publish(streamId, generation, token!, body as unknown as Checkpoint);
          await projectCheckpoint(runtime.blackboard, runtime.config.controlSurfaceDir, streamId);
        });
        runtime.wsHub?.broadcast({
          type: "status_changed",
          subsystem: "cloud-checkpoint",
          timestamp: new Date().toISOString(),
        });
        sendJson(response, 200, { ok: true, version: body.version });
        break;
      }
      default:
        sendJson(response, 404, { error: "Unknown cloud operation" });
    }
  } catch (error) {
    sendJson(response, error instanceof CloudConflict ? 409 : 400, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return true;
}

async function readBody(
  request: http.IncomingMessage,
  limit: number,
): Promise<Record<string, unknown>> {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const part of request) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    length += chunk.length;
    if (length > limit) throw new Error("Cloud request exceeds size limit");
    chunks.push(chunk);
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("JSON object required");
  return body as Record<string, unknown>;
}
