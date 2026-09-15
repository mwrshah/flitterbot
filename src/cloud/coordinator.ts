import crypto from "node:crypto";
import { finalizeStreamCloseRows } from "../blackboard/query-streams.ts";
import type { VmProvider } from "./exe.ts";
import { CloudConflict, type CloudStore, type WorkerRow } from "./store.ts";

export type WorkerAssignment = { worker: WorkerRow; token: string };
export type WorkerLifecycle = {
  boot(assignment: WorkerAssignment): Promise<void>;
  ready(assignment: WorkerAssignment): Promise<boolean>;
  finalCheckpoint(assignment: WorkerAssignment): Promise<number>;
};

export class CloudCoordinator {
  private readonly operations = new Map<string, Promise<unknown>>();

  private readonly store: CloudStore;
  private readonly provider: VmProvider;
  private readonly lifecycle: WorkerLifecycle;
  private readonly sourceVm: string;
  private readonly secret: string;

  constructor(
    store: CloudStore,
    provider: VmProvider,
    lifecycle: WorkerLifecycle,
    sourceVm: string,
    secret: string,
  ) {
    if (secret.length < 32)
      throw new Error("Cloud controller secret must have at least 32 characters");
    this.store = store;
    this.provider = provider;
    this.lifecycle = lifecycle;
    this.sourceVm = sourceVm;
    this.secret = secret;
  }

  private token(streamId: string, generation: number): string {
    return crypto
      .createHmac("sha256", this.secret)
      .update(`${streamId}:${generation}`)
      .digest("hex");
  }

  private assignment(worker: WorkerRow): WorkerAssignment {
    return { worker, token: this.token(worker.stream_id, worker.generation) };
  }

  private serial<T>(streamId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(streamId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    this.operations.set(streamId, result);
    void result
      .finally(() => {
        if (this.operations.get(streamId) === result) this.operations.delete(streamId);
      })
      .catch(() => {});
    return result;
  }

  current(streamId: string): WorkerAssignment | undefined {
    const worker = this.store.get(streamId);
    return worker?.phase === "ready" ? this.assignment(worker) : undefined;
  }

  ensure(streamId: string): Promise<WorkerAssignment> {
    return this.serial(streamId, () => this.ensureOnce(streamId));
  }

  private async ensureOnce(streamId: string): Promise<WorkerAssignment> {
    this.store.requireOpen(streamId);
    let worker = this.store.get(streamId);
    if (worker?.phase === "closing") throw new CloudConflict("Stream is closing");
    if (worker && worker.phase !== "absent") {
      const presence = await this.provider.presence(worker.vm_name);
      if (presence === "stopped") throw new CloudConflict("Assigned VM is stopped, not missing");
      if (presence === "running") {
        const assignment = this.assignment(worker);
        if (worker.phase === "provisioning" || !(await this.lifecycle.ready(assignment)))
          await this.lifecycle.boot(assignment);
        if (!(await this.lifecycle.ready(assignment))) {
          throw new CloudConflict("Assigned VM exists but is unreachable; replacement is unsafe");
        }
        this.store.requireOpen(streamId);
        this.store.phase(streamId, worker.generation, "ready");
        return this.assignment(this.store.get(streamId)!);
      }
      if (worker.phase === "provisioning") {
        throw new CloudConflict("Provisioning outcome is unknown; reserved VM is not yet visible");
      }
      this.store.phase(streamId, worker.generation, "absent");
      worker = this.store.get(streamId);
    }

    const generation = (worker?.generation ?? 0) + 1;
    const name = `fb-${crypto.createHash("sha256").update(streamId).digest("hex").slice(0, 20)}-${generation}`;
    if (name === this.sourceVm) throw new CloudConflict("Refusing to replace the controller VM");
    if ((await this.provider.presence(name)) !== "absent") {
      throw new CloudConflict("Reserved VM name already exists without an ownership record");
    }
    await this.provider.prepareFork?.(this.sourceVm);
    worker = this.store.assign(streamId, name, this.token(streamId, generation));
    await this.provider.fork(this.sourceVm, name);
    const assignment = this.assignment(worker);
    await this.lifecycle.boot(assignment);
    if (!(await this.lifecycle.ready(assignment))) {
      throw new CloudConflict("VM created but worker is not ready; retry uses the same assignment");
    }
    this.store.requireOpen(streamId);
    this.store.phase(streamId, generation, "ready");
    return this.assignment(this.store.get(streamId)!);
  }

  close(streamId: string): Promise<void> {
    return this.serial(streamId, async () => {
      const worker = this.store.get(streamId);
      if (!worker || worker.phase === "absent") {
        throw new CloudConflict("No live worker is available for a final checkpoint");
      }
      this.store.phase(streamId, worker.generation, "closing");
      const version =
        worker.final_checkpoint_version ??
        (await this.lifecycle.finalCheckpoint(this.assignment(worker)));
      const published = this.store.get(streamId);
      if (
        !published ||
        published.generation !== worker.generation ||
        !published.checkpoint_path ||
        published.checkpoint_version !== version
      ) {
        throw new CloudConflict("Final checkpoint is not acknowledged; VM retained");
      }
      this.store.db.run(
        `UPDATE cloud_workers SET final_checkpoint_version = ?
        WHERE stream_id = ? AND generation = ?`,
        version,
        streamId,
        worker.generation,
      );
      if ((await this.provider.presence(worker.vm_name)) !== "absent") {
        await this.provider.remove(worker.vm_name);
      }
      const pi = this.store.db.get<{ pi_session_id: string }>(
        "SELECT pi_session_id FROM pi_sessions WHERE stream_id = ?",
        streamId,
      );
      if (!pi) throw new CloudConflict("Stream Pi session is missing");
      this.store.db.run(
        "UPDATE cloud_commands SET status = 'canceled', updated_at = ? WHERE stream_id = ? AND status = 'pending'",
        new Date().toISOString(),
        streamId,
      );
      finalizeStreamCloseRows(this.store.db, streamId, pi.pi_session_id, new Date().toISOString());
      this.store.phase(streamId, worker.generation, "absent");
    });
  }
}
