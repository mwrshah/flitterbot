/**
 * Diagnostic pipeline logger for WS → streaming store → imperative commit → Lit render.
 *
 * Enable:  localStorage.setItem('DEBUG_WS_PIPELINE', 'true')
 * Disable: localStorage.removeItem('DEBUG_WS_PIPELINE')
 *
 * Zero-cost when disabled — flag checked at entry, returns immediately.
 */

/* ── Types ── */

export type PipelineStage =
  | "WS_RECEIVED"
  | "STORE_UPDATE"
  | "QUERY_CACHE_UPDATE"
  | "IMPERATIVE_COMMIT"
  | "LIT_RENDER";

type LogDetails = Record<string, unknown>;

/* ── Flag cache ── */

let _enabled: boolean | null = null;
let _lastCheck = 0;
const CHECK_INTERVAL_MS = 2000; // re-check localStorage every 2s

function isEnabled(): boolean {
  const now = Date.now();
  if (_enabled === null || now - _lastCheck > CHECK_INTERVAL_MS) {
    _lastCheck = now;
    try {
      _enabled = localStorage.getItem("DEBUG_WS_PIPELINE") === "true";
    } catch {
      _enabled = false;
    }
  }
  return _enabled!;
}

/* ── Delta throttling ── */

const deltaCounters = new Map<string, number>();
const DELTA_LOG_INTERVAL = 10; // log every Nth delta

/* ── Dedup detection ── */

const seenCacheIds = new Map<string, string>(); // id → contentHash (for dedup warnings)

function quickHash(content: string): string {
  // Simple hash for dedup detection — not cryptographic
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
  }
  return String(hash);
}

/* ── Core logger ── */

export function pipelineLog(
  stage: PipelineStage,
  wsMessageType: string,
  details: LogDetails = {},
): void {
  if (!isEnabled()) return;

  const timestamp = new Date().toISOString().slice(11, -1); // HH:MM:SS.sss
  const prefix = `[pipeline][${stage}]`;

  console.log(
    `%c${prefix}%c ${wsMessageType}`,
    "color: #7c3aed; font-weight: bold",
    "color: #059669; font-weight: bold",
    { timestamp, ...details },
  );
}

/** Grouped log for multi-step events like message_end. */
export function pipelineGroup(
  stage: PipelineStage,
  wsMessageType: string,
  label: string,
  fn: () => void,
): void {
  if (!isEnabled()) return;

  const timestamp = new Date().toISOString().slice(11, -1);
  console.groupCollapsed(
    `%c[pipeline][${stage}]%c ${wsMessageType} — ${label} (${timestamp})`,
    "color: #7c3aed; font-weight: bold",
    "color: #059669",
  );
  fn();
  console.groupEnd();
}

/** Warn about anomalies (duplicates, unexpected states). */
export function pipelineWarn(
  stage: PipelineStage,
  wsMessageType: string,
  message: string,
  details: LogDetails = {},
): void {
  if (!isEnabled()) return;

  const timestamp = new Date().toISOString().slice(11, -1);
  console.warn(
    `[pipeline][${stage}] ⚠ ${wsMessageType}: ${message}`,
    { timestamp, ...details },
  );
}

/**
 * Log deltas with throttling — logs the first delta per key and every Nth after.
 * Returns true if this delta was logged (for callers that want to add extra info).
 */
export function pipelineDeltaLog(
  stage: PipelineStage,
  wsMessageType: string,
  throttleKey: string,
  details: LogDetails = {},
): boolean {
  if (!isEnabled()) return false;

  const count = (deltaCounters.get(throttleKey) ?? 0) + 1;
  deltaCounters.set(throttleKey, count);

  if (count === 1 || count % DELTA_LOG_INTERVAL === 0) {
    pipelineLog(stage, wsMessageType, { ...details, deltaCount: count });
    return true;
  }
  return false;
}

/** Reset delta counter for a session (call on clearSession). */
export function pipelineDeltaReset(sessionId: string): void {
  if (!isEnabled()) return;
  for (const key of deltaCounters.keys()) {
    if (key.startsWith(sessionId)) {
      deltaCounters.delete(key);
    }
  }
}

/**
 * Check for duplicate items in query cache updates.
 * Logs a WARNING if an item with the same ID and same content hash already exists.
 */
export function pipelineCheckDedup(
  itemId: string,
  content: string,
  context: string,
): void {
  if (!isEnabled()) return;

  const hash = quickHash(content);
  const existing = seenCacheIds.get(itemId);

  if (existing === hash) {
    pipelineWarn("QUERY_CACHE_UPDATE", "dedup", `Duplicate item with same content: ${itemId}`, {
      context,
    });
  }

  seenCacheIds.set(itemId, hash);
}

/** Clear dedup tracking for a session (call on clearSession). */
export function pipelineDedupeReset(): void {
  if (!isEnabled()) return;
  seenCacheIds.clear();
}
