import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { git, preserveCloneBranches } from "../git.ts";
import { readWorktreeConfig } from "../streams/worktree-config.ts";

export type CloudStart = {
  mode: "workspace" | "head" | "base";
  cwd: string;
  root?: string;
  relative?: string;
  commit?: string;
  mergeTarget?: string;
};

export async function prepareCloudStart(
  cwd: string,
  mode: CloudStart["mode"] = "workspace",
  baseRef?: string,
): Promise<CloudStart> {
  const resolved = await fs.realpath(cwd);
  let root: string;
  try {
    root = (await git(resolved, ["rev-parse", "--show-toplevel"])).trim();
  } catch (error) {
    if (mode !== "workspace") throw error;
    return { mode, cwd: resolved };
  }
  const config = await readWorktreeConfig(root);
  const branch = (await git(root, ["branch", "--show-current"])).trim();
  const target = baseRef ?? config.baseRef ?? branch;
  if (target) {
    await git(root, ["check-ref-format", "--branch", target]);
    const symbolic = (
      await git(root, ["rev-parse", "--symbolic-full-name", "--verify", target])
    ).trim();
    if (!/^refs\/(heads|remotes)\//.test(symbolic)) throw new Error("Base must name a branch");
  }
  if (mode === "base" && !target)
    throw new Error("A configured or explicit base branch is required");
  const commit = (
    await git(root, ["rev-parse", "--verify", mode === "base" ? `${target}^{commit}` : "HEAD"])
  ).trim();
  return {
    mode,
    cwd: resolved,
    root,
    relative: path.relative(await fs.realpath(root), resolved),
    commit,
    mergeTarget: target?.replace(/^origin\//, ""),
  };
}

export async function hydrateWorkspace(source: string, destination: string): Promise<void> {
  let origin: string | undefined;
  try {
    origin = (await git(source, ["remote", "get-url", "origin"])).trim();
  } catch {}
  const hasOrigin = (await git(destination, ["remote"])).split("\n").includes("origin");
  if (origin) await git(destination, ["remote", hasOrigin ? "set-url" : "add", "origin", origin]);
  else if (hasOrigin) await git(destination, ["remote", "remove", "origin"]);
  const config = await readWorktreeConfig(source);
  for (const relative of config.copyPaths) {
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative.split(/[\\/]/).some((part) => part === ".." || part.toLowerCase() === ".git")
    )
      throw new Error("Bootstrap copy path must remain inside its repository");
    const input = path.resolve(source, relative);
    const output = path.resolve(destination, relative);
    if (input === source || output === destination)
      throw new Error("Bootstrap cannot copy an entire repository");
    try {
      await fs.lstat(input);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.cp(input, output, { recursive: true });
  }
  for (const [index, command] of config.postCreate.entries()) {
    try {
      await promisify(execFile)("/bin/sh", ["-lc", command], {
        cwd: destination,
        timeout: 300_000,
        maxBuffer: 1024 * 1024,
      });
    } catch {
      throw new Error(`Workspace bootstrap hook ${index + 1} failed`);
    }
  }
}

export async function initializeWorkspace(
  start: CloudStart,
  directory: string,
  streamId: string,
): Promise<string> {
  if (start.mode === "workspace") {
    if (start.commit && (await git(start.cwd, ["rev-parse", "HEAD"])).trim() !== start.commit)
      throw new Error(
        "Source HEAD changed during provisioning; the requested snapshot is not available",
      );
    return start.cwd;
  }
  if (!start.root || !start.commit) throw new Error("A resolved repository commit is required");
  const destination = path.join(directory, "workspace");
  await git(directory, ["clone", "--no-checkout", "--", start.root, destination]);
  await preserveCloneBranches(destination);
  await git(destination, ["switch", "-c", `cloud/${streamId}`, start.commit]);
  await hydrateWorkspace(start.root, destination);
  const cwd = path.join(destination, start.relative ?? "");
  await fs.mkdir(cwd, { recursive: true });
  return cwd;
}
