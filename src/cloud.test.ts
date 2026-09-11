import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BlackboardDatabase } from "./blackboard/db.ts";
import { handleCloudApi } from "./cloud/api.ts";
import { type Checkpoint, CheckpointStore } from "./cloud/checkpoints.ts";
import { CloudClient } from "./cloud/client.ts";
import { CloudCoordinator } from "./cloud/coordinator.ts";
import type { VmPresence, VmProvider } from "./cloud/exe.ts";
import { projectCheckpoint } from "./cloud/projection.ts";
import { CheckpointPublisher } from "./cloud/publisher.ts";
import { captureRepository, git as repositoryGit, restoreRepository } from "./cloud/repository.ts";
import { CloudStore } from "./cloud/store.ts";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flitterbot-cloud-"));
  const db = new BlackboardDatabase(path.join(root, "blackboard.db"));
  const id = crypto.randomUUID();
  const pi = crypto.randomUUID();
  db.run("INSERT INTO streams (id, name) VALUES (?, 'test')", id);
  db.run(
    `INSERT INTO pi_sessions (pi_session_id, role, cwd, started_at, last_event_at, stream_id)
    VALUES (?, 'orchestrator', '/workspace', datetime('now'), datetime('now'), ?)`,
    pi,
    id,
  );
  return {
    root,
    db,
    id,
    pi,
    store: new CloudStore(db),
    async dispose() {
      db.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

function session(pi: string, version = 1): Checkpoint {
  return {
    version,
    sessions: [
      {
        piSessionId: pi,
        content: `${JSON.stringify({ type: "session", id: pi, version: 3, timestamp: new Date(0).toISOString(), cwd: "/workspace" })}\n`,
      },
    ],
  };
}

class Provider implements VmProvider {
  vms = new Map<string, VmPresence>();
  forks = 0;
  removals = 0;
  failInventory = false;
  loseCopyReply = false;
  loseDeleteReply = false;
  async presence(name: string) {
    if (this.failInventory) throw new Error("SSH unavailable");
    return this.vms.get(name) ?? "absent";
  }
  async fork(_source: string, name: string) {
    this.forks++;
    this.vms.set(name, "running");
    if (this.loseCopyReply) throw new Error("copy reply lost");
  }
  async remove(name: string) {
    this.removals++;
    this.vms.delete(name);
    if (this.loseDeleteReply) throw new Error("delete reply lost");
  }
}

test("cloud lifecycle: provision, deliver once, reconcile failures, recover, publish, and close", async () => {
  const f = await fixture();
  try {
    const provider = new Provider();
    let healthy = true;
    let publicationFailure = true;
    let publications = 0;
    const checkpoints = new CheckpointStore(f.store, path.join(f.root, "checkpoints"));
    const coordinator = new CloudCoordinator(
      f.store,
      provider,
      {
        boot: async () => {},
        ready: async () => healthy,
        finalCheckpoint: async (assignment) => {
          publications++;
          if (publicationFailure) throw new Error("upload failed");
          await checkpoints.publish(
            f.id,
            assignment.worker.generation,
            assignment.token,
            session(f.pi),
          );
          return 1;
        },
      },
      "controller",
      "x".repeat(64),
    );
    const assignments = await Promise.all(
      Array.from({ length: 10 }, () => coordinator.ensure(f.id)),
    );
    assert.equal(provider.forks, 1);
    assert.equal(new Set(assignments.map((a) => a.worker.vm_name)).size, 1);
    const first = assignments[0]!;
    f.store.enqueue(f.id, "command", { text: "run" });
    assert.equal(f.store.accept(f.id, 1, "command"), true);
    assert.equal(f.store.accept(f.id, 1, "command"), false);
    provider.failInventory = true;
    await assert.rejects(coordinator.ensure(f.id), /SSH unavailable/);
    provider.failInventory = false;
    healthy = false;
    await assert.rejects(coordinator.ensure(f.id), /unreachable/);
    assert.equal(provider.forks, 1);
    healthy = true;
    provider.vms.delete(first.worker.vm_name);
    provider.loseCopyReply = true;
    await assert.rejects(coordinator.ensure(f.id), /copy reply lost/);
    const recovered = await coordinator.ensure(f.id);
    assert.equal(recovered.worker.generation, 2);
    assert.equal(provider.forks, 2);
    assert.throws(() => f.store.authenticate(f.id, 1, first.token), /superseded/);
    assert.equal(
      f.db.get<{ status: string }>("SELECT status FROM cloud_commands WHERE id = 'command'")
        ?.status,
      "uncertain",
    );
    assert.equal(f.store.accept(f.id, 2, "command"), false);
    await assert.rejects(coordinator.close(f.id), /upload failed/);
    assert.equal(provider.removals, 0);
    publicationFailure = false;
    provider.loseDeleteReply = true;
    await assert.rejects(coordinator.close(f.id), /delete reply lost/);
    await coordinator.close(f.id);
    assert.equal(publications, 2);
    assert.equal(
      f.db.get<{ status: string }>("SELECT status FROM streams WHERE id = ?", f.id)?.status,
      "closed",
    );
  } finally {
    await f.dispose();
  }
});

test("repository pipeline preserves native history and complete Git state through publication, recovery, and archival", async () => {
  const f = await fixture();
  try {
    const repo = path.join(f.root, "source");
    await fs.mkdir(repo);
    const git = (...args: string[]) => repositoryGit(repo, args);
    await git("init", "--initial-branch=main");
    await git("config", "user.name", "Checkpoint Test");
    await git("config", "user.email", "test@example.invalid");
    await fs.writeFile(path.join(repo, "file.txt"), "original\n");
    await fs.writeFile(path.join(repo, "deleted.txt"), "delete me\n");
    await fs.writeFile(path.join(repo, ".gitignore"), "ignored.txt\n");
    await git("add", ".");
    await git("commit", "-m", "fixture");
    await fs.writeFile(path.join(repo, "file.txt"), "staged\n");
    await git("add", "file.txt");
    await fs.writeFile(path.join(repo, "file.txt"), "unstaged\n");
    await fs.rm(path.join(repo, "deleted.txt"));
    await fs.writeFile(path.join(repo, "binary.bin"), Buffer.from([0, 255, 17, 128]));
    await fs.writeFile(path.join(repo, "ignored.txt"), "not source\n");
    await fs.symlink("file.txt", path.join(repo, "link"));
    const before = await git("status", "--porcelain");
    const workspace = await captureRepository(repo);
    assert.equal(await git("status", "--porcelain"), before);
    assert.ok(!workspace.files.some((file) => file.path === "ignored.txt"));
    f.store.assign(f.id, "worker", "token");
    const checkpoints = new CheckpointStore(f.store, path.join(f.root, "checkpoints"));
    const checkpoint = { ...session(f.pi), workspace };
    const location = await checkpoints.publish(f.id, 1, "token", checkpoint);
    assert.equal(await checkpoints.publish(f.id, 1, "token", checkpoint), location);
    const mirror = path.join(f.root, "mirror");
    await restoreRepository(location, mirror);
    assert.equal(await repositoryGit(mirror, ["status", "--porcelain"]), before);
    assert.equal(await fs.readFile(path.join(mirror, "file.txt"), "utf8"), "unstaged\n");
    assert.equal(await repositoryGit(mirror, ["show", ":file.txt"]), "staged\n");
    assert.deepEqual(
      await fs.readFile(path.join(mirror, "binary.bin")),
      Buffer.from([0, 255, 17, 128]),
    );
    assert.equal(await fs.readlink(path.join(mirror, "link")), "file.txt");
    await assert.rejects(restoreRepository(location, repo), /EEXIST/);
    assert.equal(await git("status", "--porcelain"), before);
    const control = path.join(f.root, "control-surface");
    await projectCheckpoint(f.db, control, f.id);
    const published = f.db.get<{ worktree_path: string }>(
      "SELECT worktree_path FROM streams WHERE id = ?",
      f.id,
    )!;
    assert.equal(await repositoryGit(published.worktree_path, ["status", "--porcelain"]), before);
    const active = path.join(control, "sessions", `${f.pi}.jsonl`);
    assert.equal(await fs.readFile(active, "utf8"), session(f.pi).sessions[0]!.content);
    f.db.run("UPDATE streams SET status = 'closed' WHERE id = ?", f.id);
    await projectCheckpoint(f.db, control, f.id);
    await assert.rejects(fs.access(active), /ENOENT/);
    assert.equal(
      await fs.readFile(path.join(control, "archived-sessions", `${f.pi}.jsonl`), "utf8"),
      session(f.pi).sessions[0]!.content,
    );
  } finally {
    await f.dispose();
  }
});

test("authenticated HTTP pipeline keeps SQLite authoritative and retries durable checkpoints after restart", async () => {
  const f = await fixture();
  let offline = false;
  const server = http.createServer((req, res) => {
    if (offline) {
      res.writeHead(503);
      res.end();
      return;
    }
    void handleCloudApi({ blackboard: f.db, config: { controlSurfaceDir: f.root } }, req, res);
  });
  try {
    f.store.assign(f.id, "worker", "token");
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const identity = {
      controllerUrl: `http://127.0.0.1:${address.port}`,
      streamId: f.id,
      generation: 1,
      token: "token",
    };
    const client = new CloudClient(identity);
    assert.equal((await client.query("SELECT name FROM streams"))[0]!.name, "test");
    f.db.run("UPDATE streams SET name = 'live'");
    assert.equal((await client.query("SELECT name FROM streams"))[0]!.name, "live");
    for (const sql of [
      "DELETE FROM streams",
      "SELECT 1; DELETE FROM streams",
      "ATTACH DATABASE ':memory:' AS other",
    ]) {
      await assert.rejects(client.query(sql), /400/);
    }
    await assert.rejects(new CloudClient({ ...identity, token: "wrong" }).query("SELECT 1"), /401/);
    const outbox = path.join(f.root, "outbox");
    offline = true;
    const first = new CheckpointPublisher(
      outbox,
      (checkpoint) => client.checkpoint(checkpoint),
      () => {},
    );
    try {
      await first.stage(session(f.pi));
      await assert.rejects(first.flush(), /503/);
    } finally {
      first.stop();
    }
    assert.ok((await fs.readdir(outbox)).includes("1.json"));
    offline = false;
    const restarted = new CheckpointPublisher(
      outbox,
      (checkpoint) => client.checkpoint(checkpoint),
      () => {},
    );
    try {
      await restarted.flush();
    } finally {
      restarted.stop();
    }
    assert.deepEqual(await fs.readdir(outbox), []);
    assert.equal(
      await fs.readFile(path.join(f.root, "sessions", `${f.pi}.jsonl`), "utf8"),
      session(f.pi).sessions[0]!.content,
    );
    await client.checkpoint(session(f.pi));
    const changed = session(f.pi);
    changed.sessions[0]!.content += '{"type":"custom"}\n';
    await assert.rejects(client.checkpoint(changed), /409/);
    await client.checkpoint(session(f.pi, 2));
    await assert.rejects(client.checkpoint(session(f.pi)), /409/);
    await assert.rejects(client.checkpoint(session(crypto.randomUUID(), 3)));
    const hostile = session(f.pi, 3);
    hostile.workspace = {
      head: "a".repeat(40),
      branch: "test",
      bundle: "",
      files: [{ path: "../outside", data: "" }],
    };
    await assert.rejects(client.checkpoint(hostile));
    assert.equal(f.store.get(f.id)?.checkpoint_version, 2);
    f.store.phase(f.id, 1, "absent");
    await assert.rejects(client.query("SELECT 1"), /401/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.dispose();
  }
});
