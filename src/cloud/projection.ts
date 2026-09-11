import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { BlackboardDatabase } from "../blackboard/db.ts";
import { restoreRepository } from "./repository.ts";

export async function projectCheckpoint(
  db: BlackboardDatabase,
  controlSurfaceDir: string,
  streamId: string,
): Promise<void> {
  const row = db.get<{
    pi_session_id: string;
    session_file: string | null;
    checkpoint_path: string | null;
    status: string;
  }>(
    `SELECT p.pi_session_id, p.session_file, w.checkpoint_path, s.status FROM cloud_workers w
      JOIN streams s ON s.id = w.stream_id JOIN pi_sessions p ON p.stream_id = w.stream_id WHERE w.stream_id = ?`,
    streamId,
  );
  if (!row?.checkpoint_path) return;
  const manifest = JSON.parse(
    await fs.readFile(path.join(row.checkpoint_path, "manifest.json"), "utf8"),
  );
  if (manifest.workspace) {
    const checkout = path.join(row.checkpoint_path, "checkout");
    try {
      await fs.access(path.join(checkout, ".git"));
    } catch {
      const staging = path.join(row.checkpoint_path, `.checkout-${crypto.randomUUID()}`);
      try {
        await restoreRepository(row.checkpoint_path, staging);
        await fs.rename(staging, checkout);
      } finally {
        await fs.rm(staging, { recursive: true, force: true });
      }
    }
    db.run("UPDATE streams SET worktree_path = ? WHERE id = ?", checkout, streamId);
  }
  const directory = path.join(
    controlSurfaceDir,
    row.status === "closed" ? "archived-sessions" : "sessions",
  );
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const basename = row.session_file
    ? path.basename(row.session_file)
    : `${row.pi_session_id}.jsonl`;
  const target = path.join(directory, basename);
  const temporary = path.join(directory, `.checkpoint-${crypto.randomUUID()}`);
  try {
    await fs.copyFile(
      path.join(row.checkpoint_path, "sessions", `${row.pi_session_id}.jsonl`),
      temporary,
    );
    await fs.chmod(temporary, 0o600);
    const handle = await fs.open(temporary, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, target);
    const dir = await fs.open(directory, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
    db.run(
      "UPDATE pi_sessions SET session_file = ? WHERE pi_session_id = ? AND stream_id = ?",
      target,
      row.pi_session_id,
      streamId,
    );
    for (const folder of ["sessions", "archived-sessions"]) {
      const other = path.join(controlSurfaceDir, folder, basename);
      if (other === target) continue;
      let content: string;
      try {
        content = await fs.readFile(other, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (JSON.parse(content.split("\n", 1)[0]!).id !== row.pi_session_id) {
        throw new Error("Conflicting session identity in checkpoint projection");
      }
      await fs.unlink(other);
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

const publications = new Map<string, Promise<unknown>>();

export function serializePublication<T>(
  db: BlackboardDatabase,
  streamId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${db.path}:${streamId}`;
  const previous = publications.get(key) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(operation);
  publications.set(key, result);
  void result
    .finally(() => {
      if (publications.get(key) === result) publications.delete(key);
    })
    .catch(() => {});
  return result;
}
