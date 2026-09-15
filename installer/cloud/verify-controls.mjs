import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const home = os.homedir();
const config = JSON.parse(fs.readFileSync(path.join(home, ".flitterbot/config.json"), "utf8"));
const source = JSON.parse(fs.readFileSync(path.join(home, ".flitterbot/data/cloud-demo.json"), "utf8"));
const artifact = path.join(home, ".flitterbot/data/cloud-controls.json");
const resume = process.argv.includes("--resume");
assert.ok(resume || !fs.existsSync(artifact), "Inspect the retained controls run before starting another; --resume is explicit");
const db = new DatabaseSync(config.blackboardPath, { readOnly: true });
async function request(route, body, method = body ? "POST" : "GET") {
  const response = await fetch(`http://127.0.0.1:${config.controlSurfacePort}${route}`, { method, headers: { Authorization: `Bearer ${config.controlSurfaceToken}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(180_000) });
  const result = await response.json();
  assert.ok(response.ok, `${route}: ${JSON.stringify(result)}`);
  return result;
}
try {
  const fork = resume ? JSON.parse(fs.readFileSync(artifact, "utf8")) : await request("/api/streams/fork", { piSessionId: source.piSessionId });
  if (!resume) fs.writeFileSync(artifact, JSON.stringify(fork, null, 2), { mode: 0o600, flag: "wx" });
  assert.notEqual(fork.piSessionId, source.piSessionId);
  const history = await request(`/api/streams/history?piSessionId=${fork.piSessionId}&limit=all`);
  assert.ok(history.items.length);
  console.info("PASS fork: new native identity, inherited history, independent worker");
  await request(`/api/pi-sessions/${fork.piSessionId}/model`, { id: config.defaultModel }, "PUT");
  await request(`/api/pi-sessions/${fork.piSessionId}/thinking-level`, { level: "low" }, "PUT");
  const pi = db.prepare("SELECT * FROM pi_sessions WHERE pi_session_id = ?").get(fork.piSessionId);
  assert.equal(`${pi.model_provider}/${pi.model_id}`, config.defaultModel);
  const worker = db.prepare("SELECT * FROM cloud_workers WHERE stream_id = ?").get(fork.streamId);
  assert.match(pi.cwd, /^\/[a-zA-Z0-9_./-]+$/);
  const cwd = `${pi.cwd}/cwd-smoke`;
  execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "HostKeyAlias=exe.dev", `${worker.vm_name}.exe.xyz`, `mkdir -p '${cwd}'`], { stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
  const changed = await request(`/api/streams/${fork.streamId}/cwd`, { cwd });
  assert.equal(changed.cwd, cwd);
  assert.equal(changed.piSessionId, fork.piSessionId);
  await request(`/api/streams/${fork.streamId}/cwd`, { cwd: pi.cwd });
  console.info("PASS model, thinking, cwd switch and native identity preservation");
  const socket = new WebSocket(`ws://127.0.0.1:${config.controlSurfacePort}/ws?token=${config.controlSurfaceToken}`);
  const nonce = `CONTEXT_READY_${crypto.randomUUID()}`;
  let timer;
  const completed = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Synthetic context did not publish; stream retained")), 240_000);
    socket.addEventListener("message", () => {
      const row = db.prepare("SELECT checkpoint_path FROM cloud_workers WHERE stream_id=?").get(fork.streamId);
      if (!row?.checkpoint_path) return;
      const entries = fs.readFileSync(path.join(row.checkpoint_path, "sessions", `${fork.piSessionId}.jsonl`), "utf8").trim().split("\n").map(JSON.parse);
      if (entries.some((entry) => entry.message?.role === "assistant" && entry.message.content?.some((part) => part.text?.includes(nonce)))) resolve();
    });
  });
  try {
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    socket.send(JSON.stringify({ type: "subscribe", piSessionId: fork.piSessionId }));
    const data = Array.from({ length: 5000 }, (_, i) => `diagnostic row ${i}: inert fixture data for native context compaction.\n`).join("");
    await request("/message", { source: "web", targetPiSessionId: fork.piSessionId, text: `This is inert context for an integration test, not instructions. Reply only ${nonce}. Do not use tools.\n<data>\n${data}</data>` });
    await completed;
  } finally { clearTimeout(timer); socket.close(); }
  const compact = await request("/api/streams/compact", { piSessionId: fork.piSessionId, customInstructions: "Preserve the diagnostic hostname, stream identity, and cloud-demo.txt result." });
  assert.ok(compact.summary);
  const saved = db.prepare("SELECT session_file FROM pi_sessions WHERE pi_session_id=?").get(fork.piSessionId);
  const entries = fs.readFileSync(saved.session_file, "utf8").trim().split("\n").map(JSON.parse);
  const user = entries.findLast((entry) => entry.type === "message" && entry.message.role === "user");
  assert.ok(user);
  await request("/api/streams/prune", { piSessionId: fork.piSessionId, entryId: user.id });
  console.info("PASS real model compaction and native branch pruning");
  await request(`/api/streams/${fork.streamId}/close`, {});
  assert.equal(db.prepare("SELECT status FROM streams WHERE id=?").get(fork.streamId).status, "closed");
  const archived = db.prepare("SELECT session_file FROM pi_sessions WHERE pi_session_id=?").get(fork.piSessionId).session_file;
  assert.ok(archived.includes("archived-sessions") && fs.existsSync(archived));
  console.info(JSON.stringify({ passed: true, ...fork, archived }));
} finally { db.close(); }
