#!/usr/bin/env node
/**
 * Shared hook dispatcher — reads Claude Code hook payload from stdin,
 * enriches it with AUTONOMA_* env vars, POSTs to the control surface.
 *
 * Usage: echo '{"session_id":"..."}' | node hook-post.mjs <event-slug>
 *   e.g. node hook-post.mjs session-start
 */

import { readFileSync, appendFileSync, mkdirSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";

const AUTONOMA_HOME = process.env.AUTONOMA_HOME || join(process.env.HOME || "~", ".autonoma");
const LOG_DIR = process.env.AUTONOMA_LOG_DIR || join(AUTONOMA_HOME, "logs");
const ERROR_LOG = join(LOG_DIR, "hooks-errors.log");
const CONFIG_PATH = process.env.AUTONOMA_CONFIG || join(AUTONOMA_HOME, "config.json");
const POST_TIMEOUT_MS = 2000;
const ROTATE_BYTES = 10 * 1024 * 1024;

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
  if (env.AUTONOMA_AGENT_MANAGED === "1") {
    payload.agent_managed = true;
    if (env.AUTONOMA_TMUX_SESSION) payload.tmux_session = env.AUTONOMA_TMUX_SESSION;
    if (env.AUTONOMA_TASK_DESCRIPTION) payload.task_description = env.AUTONOMA_TASK_DESCRIPTION;
    if (env.AUTONOMA_TODOIST_TASK_ID) payload.todoist_task_id = env.AUTONOMA_TODOIST_TASK_ID;
    if (env.AUTONOMA_PI_SESSION_ID) payload.pi_session_id = env.AUTONOMA_PI_SESSION_ID;
    if (env.AUTONOMA_WORKSTREAM_ID) payload.workstream_id = env.AUTONOMA_WORKSTREAM_ID;
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
