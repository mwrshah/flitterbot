import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git, preserveCloneBranches } from "../git.ts";
import type { Checkpoint, CheckpointFile } from "./checkpoints.ts";

export async function captureRepository(
  cwd: string,
): Promise<NonNullable<Checkpoint["workspace"]>> {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  if ((await fs.realpath(root)) !== (await fs.realpath(cwd)))
    throw new Error("Checkpoint cwd must be the repository root");
  const head = (await git(cwd, ["rev-parse", "HEAD"])).trim();
  const branch = (await git(cwd, ["branch", "--show-current"])).trim() || "HEAD";
  const stagedPatch = await git(cwd, [
    "diff",
    "--cached",
    "--binary",
    "--full-index",
    "--no-ext-diff",
  ]);
  const tracked = await git(cwd, ["ls-files", "--stage", "-z"]);
  if (tracked.split("\0").some((entry) => entry.startsWith("160000 "))) {
    throw new Error("Submodule workspaces require their own checkpoints");
  }
  const names = new Set(
    (await git(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]))
      .split("\0")
      .filter(Boolean),
  );
  const files: CheckpointFile[] = [];
  let bytes = 0;
  for (const name of names) {
    const source = path.join(cwd, name);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile() && !stat.isSymbolicLink())
      throw new Error(`Unsupported repository entry: ${name}`);
    bytes += stat.size;
    if (bytes > 128 * 1024 * 1024) throw new Error("Workspace exceeds checkpoint size limit");
    const data = stat.isSymbolicLink()
      ? Buffer.from(await fs.readlink(source))
      : await fs.readFile(source);
    files.push({
      path: name,
      data: data.toString("base64"),
      executable: Boolean(stat.mode & 0o111),
      symlink: stat.isSymbolicLink(),
    });
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "flitterbot-bundle-"));
  try {
    const bundleFile = path.join(temporary, "repository.bundle");
    await git(cwd, ["bundle", "create", bundleFile, "--all"]);
    if (
      (await git(cwd, ["rev-parse", "HEAD"])).trim() !== head ||
      ((await git(cwd, ["branch", "--show-current"])).trim() || "HEAD") !== branch ||
      (await git(cwd, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff"])) !==
        stagedPatch
    ) {
      throw new Error(
        "Repository HEAD or index changed during checkpoint; retry after writers settle",
      );
    }
    return {
      head,
      branch,
      detached: branch === "HEAD",
      stagedPatch,
      files,
      bundle: (await fs.readFile(bundleFile)).toString("base64"),
    };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

export async function restoreRepository(
  checkpointDirectory: string,
  destination: string,
): Promise<void> {
  const manifest = JSON.parse(
    await fs.readFile(path.join(checkpointDirectory, "manifest.json"), "utf8"),
  );
  if (!manifest.workspace || !/^[a-f0-9]{40,64}$/.test(manifest.workspace.head))
    throw new Error("Checkpoint has no valid repository");
  await fs.mkdir(destination, { recursive: false }); // Refuse to overwrite existing work.
  try {
    await git(destination, [
      "clone",
      "--no-checkout",
      "--",
      path.join(checkpointDirectory, "repository.bundle"),
      ".",
    ]);
    await preserveCloneBranches(destination);
    await git(destination, ["switch", "--detach", manifest.workspace.head]);
    if (!manifest.workspace.detached) {
      await git(destination, ["check-ref-format", "--branch", manifest.workspace.branch]);
      await git(destination, ["switch", "-C", manifest.workspace.branch, manifest.workspace.head]);
    }
    const tracked = (await git(destination, ["ls-files", "-z"])).split("\0").filter(Boolean);
    for (const name of tracked) await fs.rm(path.join(destination, name), { force: true });
    await fs.cp(path.join(checkpointDirectory, "workspace"), destination, {
      recursive: true,
      verbatimSymlinks: true,
    });
    const patch = path.join(checkpointDirectory, "index.patch");
    if ((await fs.stat(patch)).size > 0)
      await git(destination, ["apply", "--cached", "--binary", patch]);
    await git(destination, ["remote", "remove", "origin"]);
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true });
    throw error;
  }
}
