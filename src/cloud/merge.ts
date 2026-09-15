import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git } from "../git.ts";
import type { CloudStore } from "./store.ts";

const repositories = new Map<string, Promise<unknown>>();

export async function mergeCheckpoint(
  store: CloudStore,
  streamId: string,
  generation: number,
  baseBranch: string,
) {
  store.requireOpen(streamId);
  const stream = store.db.get<{ repo_path: string | null }>(
    "SELECT repo_path FROM streams WHERE id = ?",
    streamId,
  );
  if (!stream?.repo_path) throw new Error("No canonical repository is recorded for this stream");
  const repo = await fs.realpath(stream.repo_path);
  const previous = repositories.get(repo) ?? Promise.resolve();
  const operation = previous
    .catch(() => {})
    .then(async () => {
      const worker = store.get(streamId);
      if (worker?.generation !== generation || worker.phase !== "ready" || !worker.checkpoint_path)
        throw new Error("Worker is closing, superseded, or has no checkpoint");
      await git(repo, ["check-ref-format", "--branch", baseBranch]);
      await git(repo, ["show-ref", "--verify", `refs/heads/${baseBranch}`]);
      const manifest = JSON.parse(
        await fs.readFile(path.join(worker.checkpoint_path, "manifest.json"), "utf8"),
      );
      if (!/^[a-f0-9]{40,64}$/.test(manifest.workspace?.head ?? ""))
        throw new Error("Checkpoint has no Git commit");
      const entries = (await git(repo, ["worktree", "list", "--porcelain"])).split("\n\n");
      const target = entries.find((entry) =>
        entry.split("\n").includes(`branch refs/heads/${baseBranch}`),
      );
      const temporary = !target;
      const cwd =
        target
          ?.split("\n")
          .find((line) => line.startsWith("worktree "))
          ?.slice(9) ?? path.join(os.tmpdir(), `flitterbot-merge-${randomUUID()}`);
      if (temporary) await git(repo, ["worktree", "add", "--", cwd, baseBranch]);
      try {
        if ((await git(cwd, ["status", "--porcelain"])).trim())
          throw new Error(
            "Merge target has uncommitted work; preserve or commit it before merging",
          );
        const ref = `refs/flitterbot/${streamId}/${generation}`;
        await git(repo, [
          "fetch",
          "--no-tags",
          "--",
          path.join(worker.checkpoint_path, "repository.bundle"),
          `${manifest.workspace.head}:${ref}`,
        ]);
        if (
          store.get(streamId)?.generation !== generation ||
          store.get(streamId)?.phase !== "ready"
        )
          throw new Error("Worker ownership changed before merge");
        try {
          await git(cwd, ["merge", "--no-edit", ref]);
        } catch (error) {
          const conflicts = (await git(cwd, ["diff", "--name-only", "--diff-filter=U"]))
            .trim()
            .split("\n")
            .filter(Boolean);
          await git(cwd, ["merge", "--abort"]).catch(() => {});
          return {
            ok: false,
            conflicts,
            message: error instanceof Error ? error.message : String(error),
            mergeCwd: cwd,
          };
        }
        return { ok: true, merged: true, pushed: false, mergeCwd: cwd };
      } finally {
        if (temporary && !(await git(cwd, ["status", "--porcelain"])).trim())
          await git(repo, ["worktree", "remove", cwd]);
      }
    });
  repositories.set(repo, operation);
  try {
    return await operation;
  } finally {
    if (repositories.get(repo) === operation) repositories.delete(repo);
  }
}
