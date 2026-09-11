import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { CloudConflict, type CloudStore } from "./store.ts";

export type CheckpointFile = {
  path: string;
  data: string;
  executable?: boolean;
  symlink?: boolean;
};
export type SessionArtifact = { piSessionId: string; content: string };
export type Checkpoint = {
  version: number;
  sessions: SessionArtifact[];
  workspace?: {
    head: string;
    branch: string;
    baseRef?: string;
    bundle: string;
    stagedPatch?: string;
    files: CheckpointFile[];
  };
};
const LIMIT = 128 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function safeRelativePath(value: string): void {
  if (
    !value ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    value
      .split("/")
      .some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
  ) {
    throw new Error("Unsafe checkpoint file path");
  }
}

function decodeBase64(value: string): Buffer {
  if (typeof value !== "string" || value.length > LIMIT * 1.4 || value.length % 4 !== 0) {
    throw new Error("Invalid or oversized checkpoint file encoding");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error("Invalid checkpoint file encoding");
  return decoded;
}

export class CheckpointStore {
  private readonly store: CloudStore;
  private readonly root: string;

  constructor(store: CloudStore, root: string) {
    this.store = store;
    this.root = root;
  }

  async publish(
    streamId: string,
    generation: number,
    token: string,
    checkpoint: Checkpoint,
  ): Promise<string> {
    const worker = this.store.authenticate(streamId, generation, token);
    if (
      worker.final_checkpoint_version !== null &&
      checkpoint.version !== worker.final_checkpoint_version
    ) {
      throw new CloudConflict("Worker publication is sealed by its final checkpoint");
    }
    if (!Number.isSafeInteger(checkpoint.version) || checkpoint.version < 1) {
      throw new Error("Checkpoint version must be a positive safe integer");
    }
    if (
      !Array.isArray(checkpoint.sessions) ||
      checkpoint.sessions.length === 0 ||
      checkpoint.sessions.length > 1000
    ) {
      throw new Error("Checkpoint requires session artifacts");
    }
    const owner = this.store.db.get<{ pi_session_id: string }>(
      "SELECT pi_session_id FROM pi_sessions WHERE stream_id = ?",
      streamId,
    );
    if (
      !owner ||
      !checkpoint.sessions.some((session) => session.piSessionId === owner.pi_session_id)
    ) {
      throw new CloudConflict("Checkpoint does not contain the stream's Pi session");
    }
    const permitted = new Set([owner.pi_session_id]);
    const seen = new Set<string>();
    let size = 0;
    for (const session of checkpoint.sessions) {
      if (
        !UUID.test(session.piSessionId) ||
        !permitted.has(session.piSessionId) ||
        seen.has(session.piSessionId)
      ) {
        throw new CloudConflict("Unexpected or duplicate checkpoint session");
      }
      seen.add(session.piSessionId);
      if (typeof session.content !== "string" || !session.content.endsWith("\n")) {
        throw new Error("Session checkpoint must contain complete JSONL lines");
      }
      const lines = session.content.trimEnd().split("\n");
      const header = JSON.parse(lines[0]!);
      if (header.type !== "session" || header.id !== session.piSessionId) {
        throw new Error("Session checkpoint identity mismatch");
      }
      for (const line of lines.slice(1)) JSON.parse(line);
      size += Buffer.byteLength(session.content);
    }
    const files = checkpoint.workspace?.files ?? [];
    if (!Array.isArray(files) || files.length > 100_000)
      throw new Error("Invalid workspace file list");
    const paths = new Set<string>();
    const decoded = files.map((file) => {
      safeRelativePath(file.path);
      if (paths.has(file.path)) throw new Error("Duplicate workspace file path");
      paths.add(file.path);
      const data = decodeBase64(file.data);
      if (file.symlink) {
        const target = data.toString("utf8");
        const resolved = path.posix.normalize(
          path.posix.join(path.posix.dirname(file.path), target),
        );
        if (
          !target ||
          target.includes("\0") ||
          path.posix.isAbsolute(target) ||
          resolved === ".." ||
          resolved.startsWith("../")
        ) {
          throw new Error("Checkpoint symlink must stay inside the workspace");
        }
      }
      size += data.length;
      if (size > LIMIT) throw new Error("Checkpoint exceeds 128 MiB");
      return { ...file, data };
    });
    for (const filePath of paths) {
      let parent = path.posix.dirname(filePath);
      while (parent !== ".") {
        if (paths.has(parent)) throw new Error("Workspace entry overlaps a parent file or symlink");
        parent = path.posix.dirname(parent);
      }
    }
    const bundle = checkpoint.workspace ? decodeBase64(checkpoint.workspace.bundle) : undefined;
    const stagedPatch = checkpoint.workspace?.stagedPatch ?? "";
    if (typeof stagedPatch !== "string") throw new Error("Invalid Git index patch");
    size += (bundle?.length ?? 0) + Buffer.byteLength(stagedPatch);
    if (size > LIMIT) throw new Error("Checkpoint exceeds 128 MiB");
    if (
      checkpoint.workspace &&
      (!/^[a-f0-9]{40,64}$/.test(checkpoint.workspace.head) ||
        typeof checkpoint.workspace.branch !== "string")
    )
      throw new Error("Invalid Git checkpoint identity");

    const streamRoot = path.join(
      this.root,
      crypto.createHash("sha256").update(streamId).digest("hex"),
    );
    const destination = path.join(streamRoot, `${generation}-${checkpoint.version}`);
    const digest = crypto.createHash("sha256").update(JSON.stringify(checkpoint)).digest("hex");
    if (checkpoint.version <= worker.checkpoint_version) {
      if (
        checkpoint.version !== worker.checkpoint_version ||
        worker.checkpoint_path !== destination ||
        (await fs.readFile(path.join(destination, "sha256"), "utf8")) !== digest
      ) {
        throw new CloudConflict("Stale checkpoint or conflicting retry");
      }
      return destination;
    }
    await fs.mkdir(streamRoot, { recursive: true, mode: 0o700 });
    const staging = await fs.mkdtemp(path.join(streamRoot, ".incoming-"));
    try {
      await fs.mkdir(path.join(staging, "sessions"));
      for (const session of checkpoint.sessions) {
        await durableWrite(
          path.join(staging, "sessions", `${session.piSessionId}.jsonl`),
          session.content,
        );
      }
      if (checkpoint.workspace) {
        await fs.mkdir(path.join(staging, "workspace"));
        for (const file of decoded) {
          const target = path.join(staging, "workspace", file.path);
          await fs.mkdir(path.dirname(target), { recursive: true });
          if (file.symlink) await fs.symlink(file.data.toString("utf8"), target);
          else await durableWrite(target, file.data, file.executable ? 0o700 : 0o600);
        }
        await durableWrite(path.join(staging, "repository.bundle"), bundle!);
        await durableWrite(path.join(staging, "index.patch"), stagedPatch);
      }
      await durableWrite(
        path.join(staging, "manifest.json"),
        JSON.stringify({
          version: checkpoint.version,
          generation,
          streamId,
          sessions: checkpoint.sessions.map((session) => session.piSessionId),
          workspace: checkpoint.workspace
            ? {
                head: checkpoint.workspace.head,
                branch: checkpoint.workspace.branch,
                baseRef: checkpoint.workspace.baseRef,
              }
            : null,
        }),
      );
      await durableWrite(path.join(staging, "sha256"), digest);
      await syncTreeDirectories(staging);
      this.store.authenticate(streamId, generation, token);
      try {
        await fs.rename(staging, destination);
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
        if ((await fs.readFile(path.join(destination, "sha256"), "utf8")) !== digest) {
          throw new CloudConflict("Checkpoint version already contains different data");
        }
      }
      await syncDirectory(streamRoot);
      this.store.authenticate(streamId, generation, token);
      const current = this.store.get(streamId)!;
      if (
        current.checkpoint_version === checkpoint.version &&
        current.checkpoint_path === destination
      )
        return destination;
      this.store.checkpoint(streamId, generation, checkpoint.version, destination);
      return destination;
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }
}

async function durableWrite(target: string, content: string | Buffer, mode = 0o600): Promise<void> {
  const handle = await fs.open(target, "wx", mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncTreeDirectories(target: string): Promise<void> {
  for (const entry of await fs.readdir(target, { withFileTypes: true })) {
    if (entry.isDirectory()) await syncTreeDirectories(path.join(target, entry.name));
  }
  await syncDirectory(target);
}

async function syncDirectory(target: string): Promise<void> {
  const handle = await fs.open(target, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
