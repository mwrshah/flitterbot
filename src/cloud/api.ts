import type http from "node:http";
import path from "node:path";
import { executeBlackboardQuery } from "../blackboard/tool-query-blackboard.ts";
import { sendJson } from "../routes/_shared.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { type Checkpoint, CheckpointStore } from "./checkpoints.ts";
import { projectCheckpoint, serializePublication } from "./projection.ts";
import { CloudConflict, CloudStore } from "./store.ts";

export const CLOUD_API_PREFIX = "/internal/cloud/";
const MAX_REQUEST = 180 * 1024 * 1024;

type ApiRuntime = Pick<ControlSurfaceRuntime, "blackboard"> & {
  config: Pick<ControlSurfaceRuntime["config"], "controlSurfaceDir">;
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
    const body = await readBody(request, operation === "checkpoint" ? MAX_REQUEST : 1024 * 1024);
    store.authenticate(streamId, generation, token!); // Upload may overlap worker replacement.
    switch (operation) {
      case "query": {
        const sql = typeof body.sql === "string" ? body.sql : undefined;
        const mode = typeof body.mode === "string" ? body.mode : undefined;
        const rows = executeBlackboardQuery(runtime.blackboard, sql, mode);
        sendJson(response, 200, { rows });
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
      case "accept": {
        if (typeof body.id !== "string") throw new Error("Command ID required");
        sendJson(response, 200, { accepted: store.accept(streamId, generation, body.id) });
        break;
      }
      case "complete": {
        if (typeof body.id !== "string") throw new Error("Command ID required");
        store.complete(streamId, generation, body.id);
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
