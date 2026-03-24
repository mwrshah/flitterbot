import type http from "node:http";
import { getActiveHealthFlags } from "../blackboard/query-health-flags.ts";
import { getStaleSessions } from "../blackboard/query-sessions.ts";
import type { CronTickResponse } from "../contracts/index.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { requireBearer, sendJson } from "./_shared.ts";

const CRON_PREFIX = "[cron] ";
const STALE_PROMPT_PREFIX = `${CRON_PREFIX}Stale session check:`;
const IDLE_PROMPT =
  `${CRON_PREFIX}Idle check: All tracked Claude Code sessions appear stopped or idle. ` +
  "Review the latest session state, recent transcripts, Obsidian context, and Todoist context. " +
  "Figure out what the user most likely wants to tackle next. If an obvious next prompt exists " +
  "for an idle Claude session, consider continuing it. If parallel Claude Code work would help, " +
  "prepare a concrete suggestion and ask the user for confirmation before launching anything significant.";

function skip(
  res: http.ServerResponse,
  reason: CronTickResponse["reason"],
  flags?: string[],
): void {
  const body: CronTickResponse = { ok: true, action: "skipped", reason };
  if (flags?.length) body.flags = flags;
  sendJson(res, 200, body);
}

export function handleCronTickRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  if (!requireBearer(req, runtime.config.controlSurfaceToken)) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }

  // Gate 1: Pi not active (already processing a turn)
  const defaultPi = runtime.sessionManager.getDefault();
  const snapshot = defaultPi.state.getSnapshot();
  if (snapshot.busy) {
    return skip(res, "pi_active");
  }

  // Gate 2: Pi not ended/crashed
  if (!defaultPi.session) {
    return skip(res, "pi_ended");
  }

  // Gate 3: WhatsApp connected
  const status = runtime.getStatus();
  if (status.whatsapp.status !== "connected") {
    return skip(res, "whatsapp_disconnected");
  }

  // Gate 4: No active circuit breakers
  const activeFlags = getActiveHealthFlags(runtime.blackboard);
  if (activeFlags.length > 0) {
    return skip(
      res,
      "circuit_breaker",
      activeFlags.map((f) => f.flag),
    );
  }

  // Gate 5: Check for stale sessions (already marked by maintenance loop) and enqueue appropriate prompt
  const staleSessions = getStaleSessions(runtime.blackboard);

  if (staleSessions.length > 0) {
    const sessionList = staleSessions
      .map(
        (s) =>
          `  - ${s.sessionId.slice(0, 8)}${s.tmuxSession ? ` (${s.tmuxSession})` : ""} last activity: ${s.lastEventAt}`,
      )
      .join("\n");
    const prompt =
      `${STALE_PROMPT_PREFIX} ${staleSessions.length} session(s) appear stale:\n${sessionList}\n\n` +
      "Verify real tmux state, reconcile SQLite state if needed, and decide whether each session " +
      "should return to working, stay idle, be ended, or be re-prompted.";
    runtime.enqueue({ text: prompt, source: "cron" });
    const body: CronTickResponse = { ok: true, action: "enqueued", reason: "stale_check" };
    return sendJson(res, 200, body);
  }

  // Check if there are any working sessions (not stale, actively working)
  const workingSessions = runtime.blackboard
    .prepare("SELECT COUNT(*) AS count FROM sessions WHERE status = 'working'")
    .get() as { count: number };
  if (Number(workingSessions.count) > 0) {
    return skip(res, "no_actionable_state");
  }

  // All idle/ended — enqueue idle-work prompt
  runtime.enqueue({ text: IDLE_PROMPT, source: "cron" });
  const body: CronTickResponse = { ok: true, action: "enqueued", reason: "idle_check" };
  return sendJson(res, 200, body);
}
