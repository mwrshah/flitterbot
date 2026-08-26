import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import { getStreamForPiSession } from "../blackboard/query-streams.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { sendJson } from "./_shared.ts";

const MAX_CHANGED_LINES = 10_000;

type GitExecOpts = {
  cwd: string;
  encoding: "utf8";
  timeout: number;
  maxBuffer: number;
  env?: NodeJS.ProcessEnv;
};

async function readDiffPathspecs(cwd: string): Promise<string[]> {
  let ignore: string;
  try {
    ignore = await fs.readFile(path.join(cwd, ".ignore"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return ["."];
    throw err;
  }

  const exclusions = ignore
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, ""))
    .filter((line) => line.trim())
    .map((pattern) => `:(exclude)${pattern}`);
  return [".", ...exclusions];
}

async function prepareDiffIndex(
  execOpts: GitExecOpts,
  pathspecs: string[],
): Promise<{ execOpts: GitExecOpts; cleanup: () => Promise<void> }> {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z", "--", ...pathspecs],
    execOpts,
  );
  const untrackedFiles = stdout.split("\0").filter(Boolean);
  if (untrackedFiles.length === 0) {
    return { execOpts, cleanup: async () => {} };
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "flitterbot-diff-index-"));
  try {
    const { stdout: indexPathRaw } = await execFileAsync(
      "git",
      ["rev-parse", "--git-path", "index"],
      execOpts,
    );
    const indexPath = indexPathRaw.trim();
    const sourceIndexPath = path.isAbsolute(indexPath)
      ? indexPath
      : path.join(execOpts.cwd, indexPath);
    const tempIndexPath = path.join(tempDir, "index");
    await fs.copyFile(sourceIndexPath, tempIndexPath);

    const diffExecOpts = {
      ...execOpts,
      env: { ...process.env, ...execOpts.env, GIT_INDEX_FILE: tempIndexPath },
    };
    await execFileAsync("git", ["add", "--intent-to-add", "--", ...untrackedFiles], diffExecOpts);

    return {
      execOpts: diffExecOpts,
      cleanup: async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw err;
  }
}

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

  const baseBranch = ws.base_branch ?? "main";
  let base: string;
  try {
    const { stdout: mergeBase } = await execFileAsync(
      "git",
      ["merge-base", baseBranch, "HEAD"],
      execOpts,
    );
    base = mergeBase.trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runtime.log(`merge-base error: ${message}`);
    return sendJson(response, 500, { ok: false, error: "Failed to find merge base" });
  }

  let diffPathspecs: string[];
  let preparedDiffIndex: { execOpts: GitExecOpts; cleanup: () => Promise<void> };
  try {
    diffPathspecs = await readDiffPathspecs(execOpts.cwd);
    preparedDiffIndex = await prepareDiffIndex(execOpts, diffPathspecs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runtime.log(`diff index error: ${message}`);
    return sendJson(response, 500, { ok: false, error: "Failed to compute diff" });
  }

  try {
    let stat: string;
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["diff", base, "--stat", "--", ...diffPathspecs],
        preparedDiffIndex.execOpts,
      );
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

    if (insertions + deletions > MAX_CHANGED_LINES) {
      return sendJson(response, 200, {
        mode: "summary",
        stat,
        files,
        insertions,
        deletions,
      });
    }

    let diff: string;
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["diff", base, "--", ...diffPathspecs],
        preparedDiffIndex.execOpts,
      );
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
  } finally {
    try {
      await preparedDiffIndex.cleanup();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runtime.log(`diff index cleanup error: ${message}`);
    }
  }
}
