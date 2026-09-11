import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getStreamById } from "../blackboard/query-streams.ts";
import { resolveModelEntry } from "../config/models.ts";
import type { ControlSurfaceWebSocketServerEvent } from "../contracts/index.ts";
import { requireBearer, sendJson } from "../routes/_shared.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import type { ManagedPiSession } from "../streams/pi-session-manager.ts";
import type { QueueItem } from "../streams/turn-queue.ts";
import { CloudCoordinator, type WorkerAssignment } from "./coordinator.ts";
import { ExeVmProvider } from "./exe.ts";
import { projectCheckpoint, serializePublication } from "./projection.ts";
import { SshWorkerLifecycle } from "./ssh-worker.ts";
import { CloudStore } from "./store.ts";

export function assertControllerHost(directory: string): void {
  const marker = path.join(directory, "cloud-controller-host");
  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.writeFileSync(marker, os.hostname(), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (fs.readFileSync(marker, "utf8").trim() !== os.hostname()) {
    throw new Error(
      "This is a fork of the cloud controller; start only its assigned worker, not the main control surface",
    );
  }
}

export class CloudControl {
  private readonly runtime: ControlSurfaceRuntime;
  readonly store: CloudStore;
  readonly coordinator: CloudCoordinator;
  private readonly lifecycle: SshWorkerLifecycle;
  private readonly relays = new Map<string, WebSocket>();
  private readonly relayReady = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(runtime: ControlSurfaceRuntime) {
    this.runtime = runtime;
    this.store = new CloudStore(runtime.blackboard);
    this.lifecycle = new SshWorkerLifecycle(async (assignment) => {
      const stream = getStreamById(runtime.blackboard, assignment.worker.stream_id);
      const row = runtime.blackboard.get<{
        pi_session_id: string;
        session_file: string;
        cwd: string;
      }>(
        "SELECT pi_session_id, session_file, cwd FROM pi_sessions WHERE stream_id = ?",
        assignment.worker.stream_id,
      );
      if (!stream || !row?.session_file) throw new Error("Stream session is not materialized");
      const publishedSession = assignment.worker.checkpoint_path
        ? path.join(assignment.worker.checkpoint_path, "sessions", `${row.pi_session_id}.jsonl`)
        : row.session_file;
      return {
        sourceRoot: fileURLToPath(new URL("../../", import.meta.url)),
        checkpointDirectory: assignment.worker.checkpoint_path ?? undefined,
        sessionContent: fs.readFileSync(publishedSession, "utf8"),
        bootstrap: {
          controllerUrl: "http://127.0.0.1:3003",
          streamId: stream.id,
          generation: assignment.worker.generation,
          token: assignment.token,
          streamName: stream.name,
          piSessionId: row.pi_session_id,
          cwd: row.cwd,
          baseRef: stream.base_branch ?? undefined,
          sessionFile: row.session_file,
          checkpointVersion: assignment.worker.checkpoint_version,
          outbox: path.join(
            runtime.config.controlSurfaceDir,
            "workers",
            `${stream.id}-${assignment.worker.generation}`,
            "outbox",
          ),
        },
      };
    }, runtime.config.controlSurfacePort);
    this.coordinator = new CloudCoordinator(
      this.store,
      new ExeVmProvider(),
      this.lifecycle,
      os.hostname(),
      runtime.config.controlSurfaceToken,
    );
  }

  async reconcile(): Promise<void> {
    for (const row of this.runtime.blackboard.all<{ stream_id: string }>(
      "SELECT stream_id FROM cloud_workers WHERE checkpoint_path IS NOT NULL",
    )) {
      await serializePublication(this.runtime.blackboard, row.stream_id, () =>
        projectCheckpoint(
          this.runtime.blackboard,
          this.runtime.config.controlSurfaceDir,
          row.stream_id,
        ),
      );
    }
  }

  async close(streamId: string): Promise<void> {
    await this.coordinator.close(streamId);
    await serializePublication(this.runtime.blackboard, streamId, () =>
      projectCheckpoint(this.runtime.blackboard, this.runtime.config.controlSurfaceDir, streamId),
    );
    this.runtime.wsHub.broadcast({ type: "streams_changed", reason: "closed", streamId });
  }

  owns(streamId: string | null | undefined): boolean {
    return Boolean(streamId && getStreamById(this.runtime.blackboard, streamId)?.type === "work");
  }

  createSession(
    streamId: string,
    streamName: string,
    cwd: string,
    resumeSessionFile?: string,
  ): ManagedPiSession {
    const native = resumeSessionFile
      ? SessionManager.open(resumeSessionFile, this.runtime.config.controlSurfaceSessionsDir)
      : SessionManager.create(cwd, this.runtime.config.controlSurfaceSessionsDir);
    const file = native.getSessionFile();
    if (!file) throw new Error("Cloud stream requires a persistent Pi session");
    if (!fs.existsSync(file))
      fs.writeFileSync(file, `${JSON.stringify(native.getHeader())}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    const model = resolveModelEntry(this.runtime.config);
    return this.runtime.sessionManager.rehydrateStreamSession(
      streamId,
      streamName,
      native.getSessionId(),
      file,
      new Date().toISOString(),
      model.provider,
      model.modelId,
    );
  }

  async deliver(streamId: string, item: QueueItem): Promise<void> {
    const { id, receivedAt: _receivedAt, ...payload } = item;
    this.store.enqueue(streamId, item.serverMessageId ?? id, payload);
    const response = await this.execute(streamId, (assignment) =>
      this.lifecycle.request(assignment, "/worker/wake", {}),
    );
    if (!response.ok)
      throw new Error(
        `Worker wake failed (${response.status}); prompt remains in the central queue`,
      );
  }

  private async execute<T>(
    streamId: string,
    operation: (assignment: WorkerAssignment) => Promise<T>,
  ): Promise<T> {
    const assignment =
      this.coordinator.current(streamId) ?? (await this.coordinator.ensure(streamId));
    try {
      await this.relay(assignment);
      return await operation(assignment);
    } catch {
      const recovered = await this.coordinator.ensure(streamId);
      if (recovered.worker.generation !== assignment.worker.generation) {
        const pi = this.runtime.blackboard.get<{ pi_session_id: string }>(
          "SELECT pi_session_id FROM pi_sessions WHERE stream_id = ?",
          streamId,
        );
        if (pi)
          this.runtime.wsHub.broadcastHistoryCommit({
            type: "history_rewritten",
            piSessionId: pi.pi_session_id,
            reason: "recovery",
          });
      }
      await this.relay(recovered);
      return operation(recovered);
    }
  }

  private async relay(assignment: WorkerAssignment): Promise<void> {
    const name = assignment.worker.vm_name;
    const existing = this.relays.get(name);
    if (
      existing &&
      (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)
    )
      return this.relayReady.get(name);
    const row = this.runtime.blackboard.get<{ pi_session_id: string }>(
      "SELECT pi_session_id FROM pi_sessions WHERE stream_id = ?",
      assignment.worker.stream_id,
    );
    if (!row) throw new Error("Missing stream Pi identity");
    const url = new URL("/ws", await this.lifecycle.origin(assignment));
    url.protocol = "ws:";
    url.searchParams.set("token", assignment.token);
    const socket = new WebSocket(url);
    this.relays.set(name, socket);
    let finish!: (error?: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => finish(new Error("Worker event subscription timed out")),
        10_000,
      );
      timeout.unref();
      finish = (error) => {
        clearTimeout(timeout);
        if (error) {
          reject(error);
          socket.close();
        } else resolve();
      };
    });
    this.relayReady.set(name, ready);
    socket.addEventListener("open", () =>
      socket.send(JSON.stringify({ type: "subscribe", piSessionId: row.pi_session_id })),
    );
    socket.addEventListener("message", (event) => {
      try {
        if (
          this.store.get(assignment.worker.stream_id)?.generation !== assignment.worker.generation
        )
          return;
        const payload = JSON.parse(String(event.data)) as ControlSurfaceWebSocketServerEvent;
        if (payload.type === "subscribed" && payload.piSessionId === row.pi_session_id) {
          finish();
          return;
        }
        if (
          !["status_changed", "error"].includes(payload.type) &&
          (!("piSessionId" in payload) || payload.piSessionId !== row.pi_session_id)
        )
          return;
        if (["connected", "subscribed", "conversation_reset"].includes(payload.type)) return;
        const { position: _position, ...unpositioned } = payload;
        if (["message_end", "tool_result", "history_rewritten"].includes(payload.type)) {
          this.runtime.wsHub.broadcastHistoryCommit(
            unpositioned as ControlSurfaceWebSocketServerEvent,
          );
        } else this.runtime.wsHub.broadcast(unpositioned as ControlSurfaceWebSocketServerEvent);
      } catch (error) {
        this.runtime.log(`worker event rejected: ${String(error)}`);
      }
    });
    socket.addEventListener("error", () => finish(new Error("Worker event connection failed")));
    socket.addEventListener("close", () => {
      finish(new Error("Worker event connection closed"));
      if (this.relays.get(name) === socket) {
        this.relays.delete(name);
        this.relayReady.delete(name);
      }
      if (
        !this.disposed &&
        this.store.get(assignment.worker.stream_id)?.phase === "ready" &&
        this.store.get(assignment.worker.stream_id)?.generation === assignment.worker.generation
      ) {
        const timer = setTimeout(() => {
          void this.relay(assignment).catch((error) => this.runtime.log(String(error)));
        }, 1_000);
        timer.unref();
      }
    });
    await ready;
  }

  async proxy(request: http.IncomingMessage, response: http.ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    const piSessionId =
      url.searchParams.get("piSessionId") ?? (parts[1] === "pi-sessions" ? parts[2] : undefined);
    const streamId =
      url.searchParams.get("streamId") ??
      (parts[1] === "streams" && parts[2] && /^[a-f0-9-]{36}$/.test(parts[2])
        ? parts[2]
        : undefined) ??
      (piSessionId
        ? this.runtime.blackboard.get<{ stream_id: string | null }>(
            "SELECT stream_id FROM pi_sessions WHERE pi_session_id = ?",
            piSessionId,
          )?.stream_id
        : undefined);
    if (!streamId || !this.owns(streamId)) return false;
    if (getStreamById(this.runtime.blackboard, streamId)?.status === "closed") return false;
    const remote =
      url.pathname === "/api/streams/history" ||
      url.pathname === "/api/directory-completions" ||
      (parts[1] === "pi-sessions" && ["interrupt", "diff"].includes(parts[3] ?? ""));
    if (!remote) return false;
    if (!requireBearer(request, this.runtime.config.controlSurfaceToken)) {
      sendJson(response, 401, { error: "Unauthorized" });
      return true;
    }
    try {
      const historyPosition = piSessionId
        ? this.runtime.wsHub.historyPosition(piSessionId)
        : undefined;
      const upstream = await this.execute(streamId, async (assignment) => {
        if (
          this.store.db.get(
            "SELECT id FROM cloud_commands WHERE stream_id = ? AND status = 'pending' LIMIT 1",
            streamId,
          )
        ) {
          await this.lifecycle.request(assignment, "/worker/wake", {});
        }
        const target = new URL(url.pathname + url.search, await this.lifecycle.origin(assignment));
        return fetch(target, {
          method: request.method,
          headers: { Authorization: `Bearer ${assignment.token}` },
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        });
      });
      if (upstream.status === 204) {
        response.writeHead(204);
        response.end();
        return true;
      }
      const body = await upstream.json();
      if (historyPosition && upstream.ok && url.pathname === "/api/streams/history")
        body.historyPosition = historyPosition;
      sendJson(response, upstream.status, body);
    } catch (error) {
      sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const socket of this.relays.values()) socket.close();
    this.relays.clear();
    this.relayReady.clear();
    await this.lifecycle.dispose();
  }
}
