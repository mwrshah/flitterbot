#!/usr/bin/env node
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

const SURFACED_MESSAGE = (m) =>
  ((m.source === "web" || m.source === "whatsapp") && m.direction === "inbound") ||
  (m.source === "stream_outbound" && m.direction === "outbound");

const ACTIVE_PI_STATUSES = new Set(["active", "waiting_for_user", "waiting_for_sessions"]);
const RECENTLY_CLOSED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function expandHome(path) {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function parseArgs(argv) {
  const args = {
    db: "~/.flitterbot/blackboard.db",
    json: undefined,
    iterations: 1000,
    warmup: 50,
    pattern: "classifier-context",
    includeColdJson: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--db" && next) {
      args.db = next;
      i++;
    } else if (arg === "--json" && next) {
      args.json = next;
      i++;
    } else if (arg === "--iterations" && next) {
      args.iterations = Number(next);
      i++;
    } else if (arg === "--warmup" && next) {
      args.warmup = Number(next);
      i++;
    } else if (arg === "--pattern" && next) {
      args.pattern = next;
      i++;
    } else if (arg === "--include-cold-json") {
      args.includeColdJson = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(args.iterations) || args.iterations <= 0) {
    throw new Error("--iterations must be a positive integer");
  }
  if (!Number.isInteger(args.warmup) || args.warmup < 0) {
    throw new Error("--warmup must be a non-negative integer");
  }
  if (!["classifier-context", "input-surface-history"].includes(args.pattern)) {
    throw new Error('--pattern must be one of: "classifier-context", "input-surface-history"');
  }

  args.db = resolve(expandHome(args.db));
  args.json = args.json ? resolve(expandHome(args.json)) : findLatestDump();
  return args;
}

function printHelp() {
  console.log(`Benchmark blackboard access from SQLite vs JSON.

Usage:
  node benchmarks/blackboard-json-vs-sqlite.mjs [options]

Options:
  --db <path>                 SQLite DB path (default: ~/.flitterbot/blackboard.db)
  --json <path>               JSON dump path (default: latest ~/.flitterbot/exports/blackboard-dump-*.json)
  --iterations <n>            measured iterations (default: 1000)
  --warmup <n>                warmup iterations per variant (default: 50)
  --pattern <name>            classifier-context | input-surface-history (default: classifier-context)
  --include-cold-json         Also benchmark read+JSON.parse+reorganize per request
`);
}

function findLatestDump() {
  const dir = join(homedir(), ".flitterbot", "exports");
  if (!existsSync(dir)) {
    throw new Error(`No exports directory found: ${dir}. Pass --json explicitly.`);
  }
  const candidates = readdirSync(dir)
    .filter((name) => /^blackboard-dump-.*\.json$/.test(name))
    .map((name) => join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const latest = candidates[0];
  if (!latest) {
    throw new Error(`No blackboard-dump-*.json found in ${dir}. Pass --json explicitly.`);
  }
  return latest;
}

function time(fn) {
  const start = performance.now();
  const result = fn();
  const durationMs = performance.now() - start;
  return { durationMs, result };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

function summarize(name, samples, resultSummary) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    name,
    iterations: samples.length,
    medianMs: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
    resultSummary,
  };
}

function benchmark(name, iterations, warmup, fn) {
  let lastResult;
  for (let i = 0; i < warmup; i++) {
    lastResult = fn();
  }
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const measured = time(fn);
    samples.push(measured.durationMs);
    lastResult = measured.result;
  }
  return summarize(name, samples, summarizeResult(lastResult));
}

function summarizeResult(result) {
  if (Array.isArray(result)) return { rows: result.length };
  if (result && typeof result === "object") {
    return Object.fromEntries(
      Object.entries(result).map(([key, value]) => [
        key,
        Array.isArray(value) || value instanceof Map ? value.size ?? value.length : value,
      ]),
    );
  }
  return { value: result };
}

function openDb(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec("PRAGMA query_only=ON");
  db.exec("PRAGMA busy_timeout=5000");
  return db;
}

function loadDump(jsonPath) {
  return JSON.parse(readFileSync(jsonPath, "utf8"));
}

function rows(dump, table) {
  return dump.tables?.[table]?.rows ?? [];
}

function parseTime(value) {
  if (!value || typeof value !== "string") return 0;
  // SQLite's datetime() treats timezone-less values as UTC. Node parses
  // "YYYY-MM-DD HH:mm:ss" as local time, so normalize SQLite-style strings.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : 0;
}

function compareStartedDesc(a, b) {
  return parseTime(b.started_at) - parseTime(a.started_at);
}

function sqliteClassifierContext(db, defaultPiSessionId) {
  const streams = db
    .prepare("SELECT * FROM streams WHERE status = 'open' ORDER BY created_at DESC")
    .all();

  const recentConversation = db
    .prepare(
      `SELECT stream_id, stream_name, content, source, created_at, direction, sender
       FROM (
         SELECT m.stream_id, w.name AS stream_name,
                m.content, m.source, m.created_at, m.direction, m.sender,
                ROW_NUMBER() OVER (PARTITION BY m.stream_id ORDER BY m.created_at DESC) AS rn
         FROM messages m
         JOIN streams w ON w.id = m.stream_id AND w.status = 'open'
         WHERE (m.source IN ('web', 'whatsapp') AND m.direction = 'inbound' AND m.sender = 'user')
            OR (m.source = 'stream_outbound' AND m.direction = 'outbound')
       )
       WHERE rn <= ?
       ORDER BY stream_id, created_at DESC`,
    )
    .all(4);

  const latestStream = db
    .prepare("SELECT datetime(created_at) as created_at FROM streams ORDER BY created_at DESC LIMIT 1")
    .get();
  const boundary = latestStream?.created_at;
  const defaultConversation = defaultPiSessionId
    ? db
        .prepare(
          `SELECT content, source, created_at, direction, sender
           FROM messages
           WHERE pi_session_id = ?
             AND (? IS NULL OR datetime(created_at) > datetime(?))
             AND ((source IN ('web', 'whatsapp') AND direction = 'inbound' AND sender = 'user')
                  OR (source = 'stream_outbound' AND direction = 'outbound'))
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(defaultPiSessionId, boundary ?? null, boundary ?? null, 4)
    : [];

  return { streams, recentConversation, defaultConversation };
}

function jsonClassifierContextReorganize(dump, defaultPiSessionId) {
  const streamRows = rows(dump, "streams");
  const messageRows = rows(dump, "messages");
  const openStreamById = new Map();
  for (const stream of streamRows) {
    if (stream.status === "open") openStreamById.set(stream.id, stream);
  }

  const streams = [...openStreamById.values()].sort((a, b) => parseTime(b.created_at) - parseTime(a.created_at));
  const latestStreamCreatedAt = streamRows.reduce((max, stream) => Math.max(max, parseTime(stream.created_at)), 0);

  const byStream = new Map();
  const defaultCandidates = [];
  for (const message of messageRows) {
    if (!SURFACED_MESSAGE(message)) continue;
    if (message.source !== "stream_outbound" && message.sender !== "user") continue;

    if (message.stream_id && openStreamById.has(message.stream_id)) {
      const list = byStream.get(message.stream_id) ?? [];
      const stream = openStreamById.get(message.stream_id);
      list.push({
        stream_id: message.stream_id,
        stream_name: stream.name,
        content: message.content,
        source: message.source,
        created_at: message.created_at,
        direction: message.direction,
        sender: message.sender,
      });
      byStream.set(message.stream_id, list);
    }

    if (
      defaultPiSessionId &&
      message.pi_session_id === defaultPiSessionId &&
      parseTime(message.created_at) > latestStreamCreatedAt
    ) {
      defaultCandidates.push({
        content: message.content,
        source: message.source,
        created_at: message.created_at,
        direction: message.direction,
        sender: message.sender,
      });
    }
  }

  const recentConversation = [];
  for (const [streamId, list] of byStream) {
    list.sort((a, b) => parseTime(b.created_at) - parseTime(a.created_at));
    for (const item of list.slice(0, 4)) recentConversation.push(item);
  }
  recentConversation.sort((a, b) =>
    a.stream_id === b.stream_id
      ? parseTime(b.created_at) - parseTime(a.created_at)
      : a.stream_id.localeCompare(b.stream_id),
  );

  defaultCandidates.sort((a, b) => parseTime(b.created_at) - parseTime(a.created_at));
  return { streams, recentConversation, defaultConversation: defaultCandidates.slice(0, 4) };
}

function buildClassifierIndex(dump) {
  const streamRows = rows(dump, "streams");
  const openStreamById = new Map();
  for (const stream of streamRows) {
    if (stream.status === "open") openStreamById.set(stream.id, stream);
  }
  const streams = [...openStreamById.values()].sort((a, b) => parseTime(b.created_at) - parseTime(a.created_at));
  const latestStreamCreatedAt = streamRows.reduce((max, stream) => Math.max(max, parseTime(stream.created_at)), 0);

  const surfacedByOpenStream = new Map();
  const surfacedByPiSession = new Map();
  for (const message of rows(dump, "messages")) {
    if (!SURFACED_MESSAGE(message)) continue;
    if (message.source !== "stream_outbound" && message.sender !== "user") continue;

    if (message.stream_id && openStreamById.has(message.stream_id)) {
      const stream = openStreamById.get(message.stream_id);
      const list = surfacedByOpenStream.get(message.stream_id) ?? [];
      list.push({
        stream_id: message.stream_id,
        stream_name: stream.name,
        content: message.content,
        source: message.source,
        created_at: message.created_at,
        direction: message.direction,
        sender: message.sender,
      });
      surfacedByOpenStream.set(message.stream_id, list);
    }

    if (message.pi_session_id) {
      const list = surfacedByPiSession.get(message.pi_session_id) ?? [];
      list.push({
        content: message.content,
        source: message.source,
        created_at: message.created_at,
        direction: message.direction,
        sender: message.sender,
      });
      surfacedByPiSession.set(message.pi_session_id, list);
    }
  }
  for (const list of surfacedByOpenStream.values()) {
    list.sort((a, b) => parseTime(b.created_at) - parseTime(a.created_at));
  }
  for (const list of surfacedByPiSession.values()) {
    list.sort((a, b) => parseTime(b.created_at) - parseTime(a.created_at));
  }
  return { streams, latestStreamCreatedAt, surfacedByOpenStream, surfacedByPiSession };
}

function jsonClassifierContextIndexed(index, defaultPiSessionId) {
  const recentConversation = [];
  for (const [streamId, list] of index.surfacedByOpenStream) {
    for (const item of list.slice(0, 4)) recentConversation.push(item);
  }
  recentConversation.sort((a, b) =>
    a.stream_id === b.stream_id
      ? parseTime(b.created_at) - parseTime(a.created_at)
      : a.stream_id.localeCompare(b.stream_id),
  );

  const defaultConversation = defaultPiSessionId
    ? (index.surfacedByPiSession.get(defaultPiSessionId) ?? [])
        .filter((m) => parseTime(m.created_at) > index.latestStreamCreatedAt)
        .slice(0, 4)
    : [];
  return { streams: index.streams, recentConversation, defaultConversation };
}

function sqliteInputSurfaceHistory(db) {
  const piSessionIds = sqliteInputSurfacePiSessionIds(db);
  if (piSessionIds.length === 0) return [];
  const placeholders = piSessionIds.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT m.*, w.name AS stream_name
       FROM messages m
       LEFT JOIN streams w ON w.id = m.stream_id
       WHERE ((m.source IN ('web', 'whatsapp') AND m.direction = 'inbound')
              OR (m.source = 'stream_outbound' AND m.direction = 'outbound'))
         AND m.pi_session_id IN (${placeholders})
       ORDER BY m.created_at ASC`,
    )
    .all(...piSessionIds);
}

function sqliteInputSurfacePiSessionIds(db) {
  const ids = [];
  const defaultRow = db
    .prepare(
      `SELECT pi_session_id FROM pi_sessions
       WHERE role = 'default' AND status IN ('active', 'waiting_for_user', 'waiting_for_sessions')
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get();
  if (defaultRow?.pi_session_id) ids.push(defaultRow.pi_session_id);

  for (const row of db
    .prepare(
      `SELECT pi_session_id FROM pi_sessions
       WHERE role = 'orchestrator' AND status IN ('active', 'waiting_for_user', 'waiting_for_sessions')`,
    )
    .all()) {
    if (!ids.includes(row.pi_session_id)) ids.push(row.pi_session_id);
  }

  for (const row of db
    .prepare(
      `SELECT p.pi_session_id
       FROM streams s
       JOIN pi_sessions p ON p.stream_id = s.id
       WHERE s.status = 'closed'
         AND datetime(s.closed_at) >= datetime('now', '-168 hours')
         AND p.started_at = (
           SELECT MAX(p2.started_at) FROM pi_sessions p2 WHERE p2.stream_id = s.id
         )`,
    )
    .all()) {
    if (row.pi_session_id && !ids.includes(row.pi_session_id)) ids.push(row.pi_session_id);
  }

  return ids;
}

function jsonInputSurfaceHistoryReorganize(dump, nowMs) {
  const streamRows = rows(dump, "streams");
  const piRows = rows(dump, "pi_sessions");
  const messageRows = rows(dump, "messages");
  const streamById = new Map(streamRows.map((stream) => [stream.id, stream]));
  const piSessionIds = jsonInputSurfacePiSessionIds(streamRows, piRows, nowMs);
  const piSet = new Set(piSessionIds);
  const result = [];
  for (const message of messageRows) {
    if (!piSet.has(message.pi_session_id)) continue;
    if (!SURFACED_MESSAGE(message)) continue;
    const stream = message.stream_id ? streamById.get(message.stream_id) : undefined;
    result.push({ ...message, stream_name: stream?.name ?? null });
  }
  result.sort((a, b) => parseTime(a.created_at) - parseTime(b.created_at));
  return result;
}

function jsonInputSurfacePiSessionIds(streamRows, piRows, nowMs) {
  const ids = [];
  const push = (id) => {
    if (id && !ids.includes(id)) ids.push(id);
  };

  const defaultPi = piRows
    .filter((pi) => pi.role === "default" && ACTIVE_PI_STATUSES.has(pi.status))
    .sort(compareStartedDesc)[0];
  push(defaultPi?.pi_session_id);

  for (const pi of piRows) {
    if (pi.role === "orchestrator" && ACTIVE_PI_STATUSES.has(pi.status)) {
      push(pi.pi_session_id);
    }
  }

  const latestPiByStream = new Map();
  for (const pi of piRows) {
    if (!pi.stream_id) continue;
    const current = latestPiByStream.get(pi.stream_id);
    if (!current || parseTime(pi.started_at) > parseTime(current.started_at)) {
      latestPiByStream.set(pi.stream_id, pi);
    }
  }
  const cutoff = nowMs - RECENTLY_CLOSED_WINDOW_MS;
  for (const stream of streamRows) {
    if (stream.status !== "closed" || !stream.closed_at) continue;
    if (parseTime(stream.closed_at) < cutoff) continue;
    push(latestPiByStream.get(stream.id)?.pi_session_id);
  }

  return ids;
}

function buildInputSurfaceIndex(dump) {
  const streamRows = rows(dump, "streams");
  const piRows = rows(dump, "pi_sessions");
  const streamById = new Map(streamRows.map((stream) => [stream.id, stream]));
  const latestPiByStream = new Map();
  const activeDefaultPiSessions = [];
  const activeOrchestratorPiSessionIds = [];

  for (const pi of piRows) {
    if (pi.role === "default" && ACTIVE_PI_STATUSES.has(pi.status)) activeDefaultPiSessions.push(pi);
    if (pi.role === "orchestrator" && ACTIVE_PI_STATUSES.has(pi.status)) {
      activeOrchestratorPiSessionIds.push(pi.pi_session_id);
    }
    if (pi.stream_id) {
      const current = latestPiByStream.get(pi.stream_id);
      if (!current || parseTime(pi.started_at) > parseTime(current.started_at)) {
        latestPiByStream.set(pi.stream_id, pi);
      }
    }
  }
  activeDefaultPiSessions.sort(compareStartedDesc);

  const messagesByPiSession = new Map();
  for (const message of rows(dump, "messages")) {
    if (!message.pi_session_id || !SURFACED_MESSAGE(message)) continue;
    const stream = message.stream_id ? streamById.get(message.stream_id) : undefined;
    const list = messagesByPiSession.get(message.pi_session_id) ?? [];
    list.push({ ...message, stream_name: stream?.name ?? null });
    messagesByPiSession.set(message.pi_session_id, list);
  }
  for (const list of messagesByPiSession.values()) {
    list.sort((a, b) => parseTime(a.created_at) - parseTime(b.created_at));
  }

  return {
    streamRows,
    activeDefaultPiSessionId: activeDefaultPiSessions[0]?.pi_session_id,
    activeOrchestratorPiSessionIds,
    latestPiByStream,
    messagesByPiSession,
  };
}

function jsonInputSurfaceHistoryIndexed(index, nowMs) {
  const piSessionIds = [];
  const push = (id) => {
    if (id && !piSessionIds.includes(id)) piSessionIds.push(id);
  };
  push(index.activeDefaultPiSessionId);
  for (const id of index.activeOrchestratorPiSessionIds) push(id);

  const cutoff = nowMs - RECENTLY_CLOSED_WINDOW_MS;
  for (const stream of index.streamRows) {
    if (stream.status !== "closed" || !stream.closed_at) continue;
    if (parseTime(stream.closed_at) < cutoff) continue;
    push(index.latestPiByStream.get(stream.id)?.pi_session_id);
  }

  const result = [];
  for (const id of piSessionIds) {
    const list = index.messagesByPiSession.get(id);
    if (list) result.push(...list);
  }
  result.sort((a, b) => parseTime(a.created_at) - parseTime(b.created_at));
  return result;
}

function findDefaultPiSessionIdSqlite(db) {
  return db
    .prepare(
      `SELECT pi_session_id FROM pi_sessions
       WHERE role = 'default' AND status IN ('active', 'waiting_for_user', 'waiting_for_sessions')
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get()?.pi_session_id;
}

function findDefaultPiSessionIdJson(dump) {
  return rows(dump, "pi_sessions")
    .filter((pi) => pi.role === "default" && ACTIVE_PI_STATUSES.has(pi.status))
    .sort(compareStartedDesc)[0]?.pi_session_id;
}

function formatMs(value) {
  return Number(value).toFixed(3);
}

function printResults(results, metadata) {
  console.log(JSON.stringify({ metadata, results }, null, 2));
  console.log("\nSummary (ms):");
  for (const result of results) {
    console.log(
      `${result.name}: median=${formatMs(result.medianMs)} p95=${formatMs(result.p95Ms)} p99=${formatMs(result.p99Ms)} min=${formatMs(result.minMs)} max=${formatMs(result.maxMs)} rows=${JSON.stringify(result.resultSummary)}`,
    );
  }
}

const args = parseArgs(process.argv);
if (!existsSync(args.db)) throw new Error(`DB not found: ${args.db}`);
if (!existsSync(args.json)) throw new Error(`JSON dump not found: ${args.json}`);

const db = openDb(args.db);
const dump = loadDump(args.json);
const defaultPiSessionId = args.pattern === "classifier-context" ? findDefaultPiSessionIdSqlite(db) : undefined;
const defaultPiSessionIdJson = args.pattern === "classifier-context" ? findDefaultPiSessionIdJson(dump) : undefined;
const nowMs = Date.now();
const results = [];

if (args.pattern === "classifier-context") {
  const indexBuild = time(() => buildClassifierIndex(dump));
  const index = indexBuild.result;
  results.push(
    benchmark("sqlite-open-db", args.iterations, args.warmup, () =>
      sqliteClassifierContext(db, defaultPiSessionId),
    ),
  );
  results.push(
    benchmark("json-parsed-reorganize-each-request", args.iterations, args.warmup, () =>
      jsonClassifierContextReorganize(dump, defaultPiSessionIdJson),
    ),
  );
  results.push(
    benchmark("json-indexed-query", args.iterations, args.warmup, () =>
      jsonClassifierContextIndexed(index, defaultPiSessionIdJson),
    ),
  );
  results.push({
    name: "json-index-build-once",
    iterations: 1,
    medianMs: indexBuild.durationMs,
    p95Ms: indexBuild.durationMs,
    p99Ms: indexBuild.durationMs,
    minMs: indexBuild.durationMs,
    maxMs: indexBuild.durationMs,
    resultSummary: summarizeResult(index),
  });
  if (args.includeColdJson) {
    results.push(
      benchmark("json-cold-read-parse-reorganize-each-request", args.iterations, args.warmup, () => {
        const coldDump = loadDump(args.json);
        return jsonClassifierContextReorganize(coldDump, findDefaultPiSessionIdJson(coldDump));
      }),
    );
  }
} else {
  const indexBuild = time(() => buildInputSurfaceIndex(dump));
  const index = indexBuild.result;
  results.push(
    benchmark("sqlite-open-db", args.iterations, args.warmup, () => sqliteInputSurfaceHistory(db)),
  );
  results.push(
    benchmark("json-parsed-reorganize-each-request", args.iterations, args.warmup, () =>
      jsonInputSurfaceHistoryReorganize(dump, nowMs),
    ),
  );
  results.push(
    benchmark("json-indexed-query", args.iterations, args.warmup, () =>
      jsonInputSurfaceHistoryIndexed(index, nowMs),
    ),
  );
  results.push({
    name: "json-index-build-once",
    iterations: 1,
    medianMs: indexBuild.durationMs,
    p95Ms: indexBuild.durationMs,
    p99Ms: indexBuild.durationMs,
    minMs: indexBuild.durationMs,
    maxMs: indexBuild.durationMs,
    resultSummary: summarizeResult(index),
  });
  if (args.includeColdJson) {
    results.push(
      benchmark("json-cold-read-parse-reorganize-each-request", args.iterations, args.warmup, () => {
        const coldDump = loadDump(args.json);
        return jsonInputSurfaceHistoryReorganize(coldDump, nowMs);
      }),
    );
  }
}

db.close();
printResults(results, {
  pattern: args.pattern,
  iterations: args.iterations,
  warmup: args.warmup,
  db: args.db,
  json: args.json,
  dbBytes: statSync(args.db).size,
  jsonBytes: statSync(args.json).size,
});
