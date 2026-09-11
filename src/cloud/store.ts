import crypto from "node:crypto";
import type { BlackboardDatabase } from "../blackboard/db.ts";

export type WorkerRow = {
  stream_id: string;
  generation: number;
  vm_name: string;
  token_hash: string;
  phase: "provisioning" | "ready" | "closing" | "absent";
  checkpoint_version: number;
  checkpoint_path: string | null;
  final_checkpoint_version: number | null;
  updated_at: string;
};

export class CloudConflict extends Error {}

export function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export class CloudStore {
  readonly db: BlackboardDatabase;

  constructor(db: BlackboardDatabase) {
    this.db = db;
  }

  get(streamId: string): WorkerRow | undefined {
    return this.db.get<WorkerRow>("SELECT * FROM cloud_workers WHERE stream_id = ?", streamId);
  }

  requireOpen(streamId: string): void {
    const row = this.db.get<{ status: string; type: string }>(
      "SELECT status, type FROM streams WHERE id = ?",
      streamId,
    );
    if (row?.status !== "open" || row.type !== "work") {
      throw new CloudConflict("Only an open work stream can own a cloud worker");
    }
  }

  assign(streamId: string, vmName: string, token: string): WorkerRow {
    this.requireOpen(streamId);
    const current = this.get(streamId);
    if (current && current.phase !== "absent") {
      throw new CloudConflict("Existing worker must be confirmed absent before replacement");
    }
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO cloud_workers
      (stream_id, generation, vm_name, token_hash, phase, updated_at)
      VALUES (?, 1, ?, ?, 'provisioning', ?)
      ON CONFLICT(stream_id) DO UPDATE SET generation = generation + 1,
      vm_name = excluded.vm_name, token_hash = excluded.token_hash,
      phase = 'provisioning', final_checkpoint_version = NULL, updated_at = excluded.updated_at`,
      streamId,
      vmName,
      tokenHash(token),
      now,
    );
    return this.get(streamId)!;
  }

  authenticate(streamId: string, generation: number, token: string): WorkerRow {
    const row = this.get(streamId);
    const hash = tokenHash(token);
    if (
      !row ||
      row.generation !== generation ||
      row.phase === "absent" ||
      !crypto.timingSafeEqual(Buffer.from(row.token_hash), Buffer.from(hash))
    ) {
      throw new CloudConflict("Invalid or superseded worker credentials");
    }
    return row;
  }

  phase(streamId: string, generation: number, phase: WorkerRow["phase"]): void {
    const result = this.db
      .prepare(`UPDATE cloud_workers SET phase = ?, updated_at = ?
      WHERE stream_id = ? AND generation = ?`)
      .run(phase, new Date().toISOString(), streamId, generation);
    if (result.changes !== 1) throw new CloudConflict("Worker generation changed");
    if (phase === "absent") {
      this.db.run(
        `UPDATE cloud_commands SET status = 'uncertain', updated_at = ?
        WHERE stream_id = ? AND generation = ? AND status = 'accepted'`,
        new Date().toISOString(),
        streamId,
        generation,
      );
    }
  }

  checkpoint(streamId: string, generation: number, version: number, checkpointPath: string): void {
    const result = this.db
      .prepare(`UPDATE cloud_workers SET checkpoint_version = ?,
      checkpoint_path = ?, updated_at = ? WHERE stream_id = ? AND generation = ?
      AND phase != 'absent' AND final_checkpoint_version IS NULL AND checkpoint_version < ?`)
      .run(version, checkpointPath, new Date().toISOString(), streamId, generation, version);
    if (result.changes !== 1) throw new CloudConflict("Stale checkpoint or worker generation");
  }

  enqueue(streamId: string, id: string, payload: unknown): void {
    this.requireOpen(streamId);
    const worker = this.get(streamId);
    if (worker?.phase === "closing") throw new CloudConflict("Stream is not accepting commands");
    const json = JSON.stringify(payload);
    const existing = this.db.get<{ stream_id: string; payload: string }>(
      "SELECT stream_id, payload FROM cloud_commands WHERE id = ?",
      id,
    );
    if (existing) {
      if (existing.stream_id !== streamId || existing.payload !== json) {
        throw new CloudConflict("Command ID already belongs to a different request");
      }
      return;
    }
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO cloud_commands
      (id, stream_id, generation, payload, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      id,
      streamId,
      worker?.generation ?? 0,
      json,
      now,
      now,
    );
  }

  accept(streamId: string, generation: number, id: string): boolean {
    const worker = this.get(streamId);
    if (worker?.generation !== generation || worker.phase !== "ready") {
      throw new CloudConflict("Worker is not accepting commands");
    }
    const result = this.db
      .prepare(`UPDATE cloud_commands SET status = 'accepted', generation = ?, updated_at = ?
      WHERE id = ? AND stream_id = ? AND status = 'pending'`)
      .run(generation, new Date().toISOString(), id, streamId);
    return result.changes === 1;
  }

  complete(streamId: string, generation: number, id: string): void {
    const result = this.db
      .prepare(`UPDATE cloud_commands SET status = 'completed', updated_at = ?
      WHERE id = ? AND stream_id = ? AND generation = ? AND status = 'accepted'`)
      .run(new Date().toISOString(), id, streamId, generation);
    if (result.changes !== 1) throw new CloudConflict("Command is not accepted by this worker");
  }
}
