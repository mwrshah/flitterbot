import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
const home = os.homedir();
const config = JSON.parse(fs.readFileSync(path.join(home, ".flitterbot/config.json"), "utf8"));
const db = new DatabaseSync(config.blackboardPath, { readOnly: true });
const artifact = path.join(home, ".flitterbot/data/cloud-tools.json");
const resume = process.argv.includes("--resume");
assert.ok(resume || !fs.existsSync(artifact), "A tools run exists; inspect it before explicit --resume");
const base = `http://127.0.0.1:${config.controlSurfacePort}`;
async function request(route, body) {
  const response = await fetch(base + route, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${config.controlSurfaceToken}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(180_000) });
  const result = await response.json();
  assert.ok(response.ok, `${route}: ${JSON.stringify(result)}`);
  return result;
}
const socket = new WebSocket(`${base.replace("http:", "ws:")}/ws?token=${config.controlSurfaceToken}`);
const watchers = new Set();
socket.addEventListener("message", () => { for (const check of watchers) check(); });
function wait(check) { return new Promise((resolve, reject) => {
  const timer = setTimeout(() => { watchers.delete(probe); reject(new Error("Live tools run timed out; its VM and manifest are retained")); }, 180_000);
  function probe() { try { const result = check(); if (result) { clearTimeout(timer); watchers.delete(probe); resolve(result); } } catch (error) { clearTimeout(timer); watchers.delete(probe); reject(error); } }
  watchers.add(probe); probe();
}); }
let stream;
function snapshot() {
  const worker = db.prepare("SELECT * FROM cloud_workers WHERE stream_id=?").get(stream.streamId);
  if (!worker?.checkpoint_path) return;
  const entries = fs.readFileSync(path.join(worker.checkpoint_path, "sessions", `${stream.piSessionId}.jsonl`), "utf8").trim().split("\n").map(JSON.parse);
  return { worker, entries };
}
try {
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  if (resume) stream = JSON.parse(fs.readFileSync(artifact, "utf8"));
  else {
    const status = await request("/status");
    stream = await request("/api/streams", { name: "cloud-tools-demo", cwd: path.join(home, "projects/demo"), startFrom: "head", sourcePiSessionId: status.piAgent.default.piSessionId, message: "This is a disposable cloud integration test. Use set_up_worktree to inspect and apply with base_ref main. Write cloud-tools-smoke.txt containing exactly CLOUD_TOOLS_OK and a newline. Reply TOOLS_READY. Do not commit, close, push, or start other agents." });
    fs.writeFileSync(artifact, JSON.stringify(stream, null, 2), { flag: "wx", mode: 0o600 });
  }
  socket.send(JSON.stringify({ type: "subscribe", piSessionId: stream.piSessionId }));
  const ready = await wait(() => { const state = snapshot(); return state?.entries.some((entry) => entry.message?.role === "assistant" && entry.message.content?.some((part) => part.text?.includes("TOOLS_READY"))) && state; });
  assert.ok(ready.entries.some((entry) => entry.message?.toolName === "set_up_worktree" && !entry.message.isError));
  console.info("PASS native orchestration tools and clean-HEAD workspace");
  if (!stream.downstreamId) {
    const downstreamId = crypto.randomUUID();
    const code = `import fs from 'node:fs';import os from 'node:os';import{execFileSync}from'node:child_process';const b=JSON.parse(fs.readFileSync(os.homedir()+'/.flitterbot/control-surface/workers/${stream.streamId}-${ready.worker.generation}/bootstrap.json'));const result=JSON.parse(execFileSync('claude',['-p','--session-id','${downstreamId}','--model','claude-group/claude-opus-5','--output-format','json','Reply only DOWNSTREAM_OK. Do not use tools.'],{cwd:b.cwd,env:{...process.env,FLITTERBOT_AGENT_MANAGED:'1',FLITTERBOT_STREAM_ID:b.streamId,FLITTERBOT_PI_SESSION_ID:b.piSessionId,FLITTERBOT_TASK_DESCRIPTION:'Native CLI cloud transport smoke'},encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:120000}));if(!result.result?.includes('DOWNSTREAM_OK'))throw Error('Unexpected native CLI result');console.log('Native Claude CLI replied DOWNSTREAM_OK');`;
    console.info(execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "HostKeyAlias=exe.dev", `${ready.worker.vm_name}.exe.xyz`, "node --input-type=module"], { input: code, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 150_000 }).trim());
    stream.downstreamId = downstreamId;
    fs.writeFileSync(artifact, JSON.stringify(stream, null, 2), { mode: 0o600 });
  }
  const downstream = await wait(() => { const row = db.prepare("SELECT * FROM sessions WHERE session_id=?").get(stream.downstreamId); return row?.status === "ended" && row.transcript_path && fs.existsSync(row.transcript_path) && row; });
  assert.equal(downstream.stream_id, stream.streamId);
  assert.ok(fs.readFileSync(downstream.transcript_path, "utf8").includes("DOWNSTREAM_OK"));
  const transcript = await request(`/api/sessions/${stream.downstreamId}/transcript?limit=500`);
  assert.ok(JSON.stringify(transcript).includes("DOWNSTREAM_OK"));
  console.info("PASS real Claude CLI hooks, central ownership, published native transcript, transcript API");
  await request("/message", { source: "web", targetPiSessionId: stream.piSessionId, text: "The diagnostic is complete. Use close_swimlane to preview a merge into main. Do not confirm or execute the merge yet. Reply MERGE_PREVIEW_READY." });
  await wait(() => snapshot()?.entries.some((entry) => entry.message?.toolName === "close_swimlane" && JSON.stringify(entry.message).includes("needsConfirmation")));
  assert.equal(db.prepare("SELECT status FROM streams WHERE id=?").get(stream.streamId).status, "open");
  await request("/message", { source: "web", targetPiSessionId: stream.piSessionId, text: "I confirm: merge this disposable test branch into main and close this stream. Use close_swimlane with mode merge, base_branch main, and commit_message Verify cloud tool and native CLI transport. Do not push." });
  await wait(() => db.prepare("SELECT status FROM streams WHERE id=?").get(stream.streamId)?.status === "closed");
  assert.equal(fs.readFileSync(path.join(home, "projects/demo/cloud-tools-smoke.txt"), "utf8").trim(), "CLOUD_TOOLS_OK");
  assert.equal(db.prepare("SELECT phase FROM cloud_workers WHERE stream_id=?").get(stream.streamId).phase, "absent");
  console.info(JSON.stringify({ passed: true, streamId: stream.streamId, downstreamId: stream.downstreamId, checks: "preview, confirmed merge, final checkpoint, worker removal" }));
} finally { socket.close(); db.close(); }
