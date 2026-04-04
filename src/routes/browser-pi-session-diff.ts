import { execFile } from "node:child_process";
import type http from "node:http";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import { getStreamForPiSession } from "../blackboard/query-streams.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { sendJson } from "./_shared.ts";

const MAX_FILES = 50;
const MAX_CHANGED_LINES = 5000;

function parseStatSummary(stat: string): {
  files: number;
  insertions: number;
  deletions: number;
} {
  const summaryLine = stat.trimEnd().split("\n").at(-1) ?? "";
  const filesMatch = summaryLine.match(/(\d+)\s+files?\s+changed/);
  const insMatch = summaryLine.match(/(\d+)\s+insertions?\(\+\)/);
  const delMatch = summaryLine.match(/(\d+)\s+deletions?\(-\)/);
  return {
    files: filesMatch ? Number(filesMatch[1]) : 0,
    insertions: insMatch ? Number(insMatch[1]) : 0,
    deletions: delMatch ? Number(delMatch[1]) : 0,
  };
}

export async function handleBrowserPiSessionDiffRoute(
  runtime: ControlSurfaceRuntime,
  _request: http.IncomingMessage,
  response: http.ServerResponse,
  piSessionId: string,
) {
  const ws = getStreamForPiSession(runtime.blackboard, piSessionId);
  if (!ws?.worktree_path) {
    response.statusCode = 204;
    response.end();
    return;
  }

  const execOpts = {
    cwd: ws.worktree_path,
    encoding: "utf8" as const,
    timeout: 10_000,
    maxBuffer: 5 * 1024 * 1024,
  };

  // Find the fork point from main
  let base: string;
  try {
    const { stdout: mergeBase } = await execFileAsync(
      "git",
      ["merge-base", "main", "HEAD"],
      execOpts,
    );
    base = mergeBase.trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runtime.log(`merge-base error: ${message}`);
    return sendJson(response, 500, { ok: false, error: "Failed to find merge base" });
  }

  // Preflight: cheap --stat to check size
  let stat: string;
  try {
    const { stdout } = await execFileAsync("git", ["diff", base, "--stat"], execOpts);
    stat = stdout;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runtime.log(`diff stat error: ${message}`);
    return sendJson(response, 500, { ok: false, error: "Failed to compute diff" });
  }

  if (!stat.trim()) {
    response.statusCode = 204;
    response.end();
    return;
  }

  const { files, insertions, deletions } = parseStatSummary(stat);

  if (files > MAX_FILES || insertions + deletions > MAX_CHANGED_LINES) {
    return sendJson(response, 200, {
      mode: "summary",
      stat,
      files,
      insertions,
      deletions,
    });
  }

  // Full diff
  let diff: string;
  try {
    const { stdout } = await execFileAsync("git", ["diff", base], execOpts);
    diff = stdout;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runtime.log(`diff route error: ${message}`);
    return sendJson(response, 500, { ok: false, error: "Failed to compute diff" });
  }

  if (!diff.trim()) {
    response.statusCode = 204;
    response.end();
    return;
  }

  return sendJson(response, 200, { mode: "diff", diff });
}
