#!/usr/bin/env node

import { readFileSync, appendFileSync, mkdirSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";

const FLITTERBOT_HOME = process.env.FLITTERBOT_HOME || join(process.env.HOME || "~", ".flitterbot");
const LOG_DIR = process.env.FLITTERBOT_LOG_DIR || join(FLITTERBOT_HOME, "logs");
const ERROR_LOG = join(LOG_DIR, "hooks-errors.log");
const CONFIG_PATH = process.env.FLITTERBOT_CONFIG || join(FLITTERBOT_HOME, "config.json");
const POST_TIMEOUT_MS = 2000;
const ROTATE_BYTES = 10 * 1024 * 1024;

// ponytail: share log rotation/config loading with installer runtime instead of another tiny copy.
function logError(message) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    try {
      const size = statSync(ERROR_LOG).size;
      if (size >= ROTATE_BYTES) {
        try { renameSync(ERROR_LOG, ERROR_LOG + ".1"); } catch {}
      }
    } catch {}
    const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    appendFileSync(ERROR_LOG, `[${ts}] ERROR ${message}\n`);
  } catch {}
}

function loadConfig() {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function enrichPayload(payload) {
  const env = process.env;
  if (env.FLITTERBOT_AGENT_MANAGED === "1") {
    payload.agent_managed = true;
    if (env.FLITTERBOT_TMUX_SESSION) payload.tmux_session = env.FLITTERBOT_TMUX_SESSION;
    if (env.FLITTERBOT_TASK_DESCRIPTION) payload.task_description = env.FLITTERBOT_TASK_DESCRIPTION;
    if (env.FLITTERBOT_TODOIST_TASK_ID) payload.todoist_task_id = env.FLITTERBOT_TODOIST_TASK_ID;
    if (env.FLITTERBOT_PI_SESSION_ID) payload.pi_session_id = env.FLITTERBOT_PI_SESSION_ID;
    if (env.FLITTERBOT_STREAM_ID) payload.stream_id = env.FLITTERBOT_STREAM_ID;
  }
  return payload;
}

function postToControlSurface(eventSlug, body, config) {
  return new Promise((resolve) => {
    const host = config.controlSurfaceHost || "127.0.0.1";
    const port = config.controlSurfacePort || 18820;
    const token = config.controlSurfaceToken || "";
    const data = Buffer.from(JSON.stringify(body));

    const headers = { "Content-Type": "application/json", "Content-Length": data.length };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const req = http.request(
      { hostname: host, port, path: `/hook/${eventSlug}`, method: "POST", headers, timeout: POST_TIMEOUT_MS },
      (res) => { res.resume(); resolve(res.statusCode); },
    );

    req.on("timeout", () => { req.destroy(); resolve("timeout"); });
    req.on("error", (err) => {
      if (err.code === "ECONNREFUSED") { resolve("skip"); return; }
      resolve("error:" + err.code);
    });

    req.write(data);
    req.end();
  });
}

async function main() {
  const eventSlug = process.argv[2];
  if (!eventSlug) { process.exit(0); }

  let raw;
  try {
    raw = readFileSync(0, "utf8").trim();
  } catch {
    process.exit(0);
  }
  if (!raw) { process.exit(0); }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    logError(`${eventSlug} invalid JSON: ${e.message}`);
    process.exit(0);
  }

  payload = enrichPayload(payload);
  const config = loadConfig();
  const result = await postToControlSurface(eventSlug, payload, config);

  if (result !== "skip" && result !== 200 && result !== 201) {
    logError(`${eventSlug} session=${payload.session_id || "?"} post=${result}`);
  }
}

main().catch((e) => { logError(`hook-post crashed: ${e.message}`); }).finally(() => process.exit(0));
