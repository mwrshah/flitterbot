import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";

const home = os.homedir();
const config = JSON.parse(fs.readFileSync(path.join(home, ".flitterbot/config.json"), "utf8"));
const manifestFile = path.join(home, ".flitterbot/data/cloud-demo.json");
const base = `http://127.0.0.1:${config.controlSurfacePort}`;
const headers = { Authorization: `Bearer ${config.controlSurfaceToken}`, "Content-Type": "application/json" };
const db = new DatabaseSync(config.blackboardPath, { readOnly: true });
async function request(route, body, method = body ? "POST" : "GET") {
  const response = await fetch(base + route, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(180_000) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${route}: ${response.status}: ${JSON.stringify(result)}`);
  return result;
}
function worker(streamId) { return db.prepare("SELECT * FROM cloud_workers WHERE stream_id = ?").get(streamId); }
function verify(manifest) {
  const current = worker(manifest.streamId);
  if (!current?.checkpoint_path) return false;
  const marker = path.join(current.checkpoint_path, "workspace/cloud-demo.txt");
  if (!fs.existsSync(marker)) return false;
  assert.equal(fs.readFileSync(marker, "utf8").trim(), manifest.initialVm ?? current.vm_name);
  const session = path.join(current.checkpoint_path, "sessions", `${manifest.piSessionId}.jsonl`);
  const entries = fs.readFileSync(session, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(entries[0].id, manifest.piSessionId);
  assert.ok(entries.some((entry) => entry.message?.role === "toolResult" && entry.message.toolName === "query_blackboard" && !entry.message.isError), "Expected a successful authoritative query tool call");
  assert.equal(fs.existsSync(path.join(home, "projects/demo/cloud-demo.txt")), false, "Canonical source must stay untouched");
  return current;
}

try {
  const action = process.argv[2] ?? "inspect";
  if (action === "create") {
    assert.equal(os.hostname(), fs.readFileSync(path.join(home, ".flitterbot/control-surface/cloud-controller-host"), "utf8").trim());
    assert.equal(fs.existsSync(manifestFile), false, "A demo already exists; inspect or close it first");
    const status = await request("/status");
    const socket = new WebSocket(`${base.replace("http:", "ws:")}/ws?token=${config.controlSurfaceToken}`);
    let manifest;
    let complete;
    let fail;
    const done = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
    const timeout = setTimeout(() => fail(new Error("Demo did not publish within 180 seconds; inspect the retained stream")), 180_000);
    socket.addEventListener("message", () => {
      if (!manifest) return;
      try { const current = verify(manifest); if (current) complete(current); } catch (error) { fail(error); }
    });
    try {
      await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
      const created = await request("/api/streams", {
        name: "cloud-demo", cwd: path.join(home, "projects/demo"), sourcePiSessionId: status.piAgent.default.piSessionId,
        message: "Run hostname and pwd using bash. Use query_blackboard to SELECT id, name FROM streams WHERE name LIKE '%cloud-demo%'. Write a plain text file cloud-demo.txt in this directory containing only your hostname and a newline. This is a small diagnostic text file, not a code change. Reply with the hostname and the database stream name. Do not commit, push, close the stream, or start any other agents.",
      });
      manifest = { streamId: created.streamId, piSessionId: created.piSessionId };
      fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), { mode: 0o600, flag: "wx" });
      socket.send(JSON.stringify({ type: "subscribe", piSessionId: manifest.piSessionId }));
      const current = verify(manifest) || await done;
      manifest.initialVm = current.vm_name;
      fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), { mode: 0o600 });
      console.info(JSON.stringify({ passed: true, ...manifest, checkpoint: current.checkpoint_version }));
    } finally { clearTimeout(timeout); socket.close(); }
  } else {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    if (action === "recover") {
      const previous = verify(manifest);
      assert.ok(previous && previous.phase === "ready");
      await request(`/api/pi-sessions/${manifest.piSessionId}/thinking-level`, { level: "medium" }, "PUT");
      assert.notEqual(previous.vm_name, os.hostname());
      console.info("Recovery: checkpoint acknowledged; removing disposable worker %s", previous.vm_name);
      execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "exe.dev", "rm", previous.vm_name, "--json"], { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
      console.info("Recovery: worker removed; requesting its history through main");
      const history = await request(`/api/streams/history?piSessionId=${manifest.piSessionId}&limit=all`);
      const replacement = verify(manifest);
      assert.ok(replacement && replacement.generation > previous.generation);
      assert.notEqual(replacement.vm_name, previous.vm_name);
      assert.ok(history.items.length > 0);
      await request(`/api/pi-sessions/${manifest.piSessionId}/thinking-level`, { level: "low" }, "PUT");
      assert.equal(verify(manifest).vm_name, replacement.vm_name);
      console.info(JSON.stringify({ passed: true, recovered: manifest.piSessionId, previous: previous.vm_name, replacement: replacement.vm_name, checkpoint: worker(manifest.streamId).checkpoint_version }));
    } else if (action === "inspect") {
      const current = verify(manifest);
      assert.ok(current, "The diagnostic checkpoint is not published yet");
      const history = await request(`/api/streams/history?piSessionId=${manifest.piSessionId}&limit=all`);
      assert.ok(history.items.length > 0);
      const changed = await request(`/api/pi-sessions/${manifest.piSessionId}/thinking-level`, { level: "medium" }, "PUT");
      assert.equal(changed.ok, true);
      const diff = await request(`/api/pi-sessions/${manifest.piSessionId}/diff`);
      assert.match(JSON.stringify(diff), /cloud-demo\.txt/);
      console.info(JSON.stringify({ passed: true, ...manifest, worker: current.vm_name, historyItems: history.items.length, controls: "thinking, history, diff" }));
    } else if (action === "close") {
      const result = await request(`/api/streams/${manifest.streamId}/close`, {});
      assert.equal(result.ok, true);
      assert.equal(db.prepare("SELECT status FROM streams WHERE id = ?").get(manifest.streamId).status, "closed");
      assert.equal(worker(manifest.streamId).phase, "absent");
      fs.appendFileSync(path.join(home, ".flitterbot/data/cloud-demo-archive.jsonl"), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
      fs.unlinkSync(manifestFile);
      console.info(JSON.stringify({ passed: true, closed: manifest.streamId, archived: true }));
    } else throw new Error("Use create, inspect, recover, or close");
  }
} finally { db.close(); }
