import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BlackboardDatabase } from "./blackboard/db.ts";
import { insertSession } from "./blackboard/query-sessions.ts";
import { handleCloudApi } from "./cloud/api.ts";
import { type Checkpoint, CheckpointStore } from "./cloud/checkpoints.ts";
import { CloudClient } from "./cloud/client.ts";
import { CloudCoordinator } from "./cloud/coordinator.ts";
import type { VmPresence, VmProvider } from "./cloud/exe.ts";
import { mergeCheckpoint } from "./cloud/merge.ts";
import { projectCheckpoint } from "./cloud/projection.ts";
import { DurableOutbox } from "./cloud/publisher.ts";
import { captureRepository, restoreRepository } from "./cloud/repository.ts";
import { CloudStore } from "./cloud/store.ts";
import { createCloudTools } from "./cloud/tools.ts";
import type { WorkerBootstrap } from "./cloud/worker-agent.ts";
import { initializeWorkspace, prepareCloudStart } from "./cloud/workspace.ts";
import type { StreamRow } from "./contracts/index.ts";
import { git as repositoryGit } from "./git.ts";

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
  failPreflight = false;
  async prepareFork() {
    if (this.failPreflight) throw new Error("flush failed");
  }
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
    provider.failPreflight = true;
    await assert.rejects(coordinator.ensure(f.id), /flush failed/);
    assert.equal(f.store.get(f.id), undefined);
    assert.equal(provider.forks, 0);
    provider.failPreflight = false;
    const assignments = await Promise.all(
      Array.from({ length: 10 }, () => coordinator.ensure(f.id)),
    );
    assert.equal(provider.forks, 1);
    assert.equal(new Set(assignments.map((a) => a.worker.vm_name)).size, 1);
    const first = assignments[0]!;
    f.store.enqueue(f.id, "discard", { text: "discard", source: "web" });
    const pending = f.store.queueSnapshot(f.id);
    assert.equal(pending.items[0]?.id, "discard");
    assert.equal(f.store.cancel(f.id, "discard").removed, true);
    assert.ok(f.store.queueSnapshot(f.id).version > pending.version);
    assert.equal(f.store.accept(f.id, 1, "discard"), false);
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
    await git("switch", "-c", "alternate");
    await fs.writeFile(path.join(repo, "file.txt"), "alternate\n");
    await git("commit", "-am", "alternate base");
    await git("switch", "main");
    await git("config", "flitterbot.baseRef", "alternate");
    await git("config", "flitterbot.copyPath", "ignored.txt");
    await git("config", "flitterbot.postCreate", "printf hydrated > bootstrap.txt");
    await fs.writeFile(path.join(repo, "file.txt"), "staged\n");
    await git("add", "file.txt");
    await fs.writeFile(path.join(repo, "file.txt"), "unstaged\n");
    await fs.rm(path.join(repo, "deleted.txt"));
    await fs.writeFile(path.join(repo, "binary.bin"), Buffer.from([0, 255, 17, 128]));
    await fs.writeFile(path.join(repo, "ignored.txt"), "not source\n");
    await fs.symlink("file.txt", path.join(repo, "link"));
    const before = await git("status", "--porcelain");
    for (const mode of ["workspace", "head", "base"] as const) {
      const start = await prepareCloudStart(repo, mode);
      const directory = path.join(f.root, mode);
      await fs.mkdir(directory);
      const cwd = await initializeWorkspace(start, directory, f.id);
      assert.equal(
        await fs.readFile(path.join(cwd, "file.txt"), "utf8"),
        mode === "workspace" ? "unstaged\n" : mode === "head" ? "original\n" : "alternate\n",
      );
      if (mode !== "workspace") {
        assert.equal(await fs.readFile(path.join(cwd, "ignored.txt"), "utf8"), "not source\n");
        assert.equal(await fs.readFile(path.join(cwd, "bootstrap.txt"), "utf8"), "hydrated");
      }
    }
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
    f.store.phase(f.id, 1, "ready");
    f.db.run("UPDATE streams SET repo_path = ? WHERE id = ?", repo, f.id);
    await assert.rejects(mergeCheckpoint(f.store, f.id, 1, "main"), /uncommitted/);
    const canonical = path.join(f.root, "canonical");
    await repositoryGit(f.root, ["clone", "--", repo, canonical]);
    f.db.run("UPDATE streams SET repo_path = ? WHERE id = ?", canonical, f.id);
    await repositoryGit(mirror, ["config", "user.name", "Checkpoint Test"]);
    await repositoryGit(mirror, ["config", "user.email", "test@example.invalid"]);
    await repositoryGit(mirror, ["add", "--all"]);
    await repositoryGit(mirror, ["commit", "-m", "worker result"]);
    const committed = await captureRepository(mirror);
    await checkpoints.publish(f.id, 1, "token", { ...session(f.pi, 2), workspace: committed });
    assert.equal((await mergeCheckpoint(f.store, f.id, 1, "main")).ok, true);
    const identity = {
      controllerUrl: "http://localhost",
      token: "token",
      streamId: f.id,
      generation: 1,
    };
    const toolClient = new CloudClient(identity);
    toolClient.request = async <T>() =>
      f.db.get<StreamRow>("SELECT * FROM streams WHERE id = ?", f.id) as T;
    const tools = createCloudTools(
      toolClient,
      {
        ...identity,
        cwd: mirror,
        controllerVm: "controller",
        piSessionId: f.pi,
        streamName: "test",
        sessionFile: path.join(f.store.get(f.id)!.checkpoint_path!, "sessions", `${f.pi}.jsonl`),
        checkpointVersion: 2,
        outbox: path.join(f.root, "outbox"),
      } as WorkerBootstrap,
      async () => {
        throw new Error("Preview must not publish");
      },
      async () => {
        throw new Error("Preview must not settle processes");
      },
      () => "same-user-entry",
    );
    const close = tools.find((tool) => tool.name === "close_swimlane")!;
    for (const base_branch of [null, "", "main", "main"]) {
      const preview = await close.execute(
        "preview",
        { mode: "merge", base_branch, commit_message: "worker result" },
        undefined,
        undefined,
        {} as never,
      );
      assert.equal((preview.details as { needsConfirmation: boolean }).needsConfirmation, true);
    }
    await assert.rejects(
      close.execute(
        "noop",
        { mode: "noop", commit_message: "preview" },
        undefined,
        undefined,
        {} as never,
      ),
      /new user response/,
    );
    assert.equal((await repositoryGit(canonical, ["rev-parse", "HEAD"])).trim(), committed.head);
    assert.equal(await repositoryGit(repo, ["status", "--porcelain"]), before);
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
  let hookCalls = 0;
  const server = http.createServer((req, res) => {
    if (offline) {
      res.writeHead(503);
      res.end();
      return;
    }
    void handleCloudApi(
      {
        blackboard: f.db,
        config: { controlSurfaceDir: f.root },
        handleHook: (_event, payload) => {
          hookCalls++;
          insertSession(f.db, {
            session_id: payload.session_id!,
            stream_id: payload.stream_id,
            pi_session_id: payload.pi_session_id,
            transcript_path: payload.transcript_path,
            cwd: payload.cwd ?? "/workspace",
            agent_managed: true,
          });
          return { ok: true };
        },
      },
      req,
      res,
    );
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
    const first = new DurableOutbox(
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
    const restarted = new DurableOutbox(
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
    f.store.phase(f.id, 1, "ready");
    const downstreamId = crypto.randomUUID();
    const hook = {
      version: 1,
      event: "session-start",
      payload: { session_id: downstreamId, transcript_path: "/worker/native.jsonl" },
      content:
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"downstream"}]}}\n',
    };
    await client.request("hook", hook);
    await client.request("hook", hook);
    assert.equal(hookCalls, 1);
    const downstream = f.db.get<{ transcript_path: string }>(
      "SELECT transcript_path FROM sessions WHERE session_id = ?",
      downstreamId,
    )!;
    assert.equal(await fs.readFile(downstream.transcript_path, "utf8"), hook.content);
    await assert.rejects(
      client.request("hook", { ...hook, version: 2, payload: { session_id: f.pi } }),
    );
    assert.equal(hookCalls, 1);
    f.store.phase(f.id, 1, "absent");
    await assert.rejects(client.query("SELECT 1"), /401/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.dispose();
  }
});
