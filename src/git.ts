import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function git(
  cwd: string,
  args: string[],
  options: { timeout?: number; maxBuffer?: number } = {},
): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const operation = exec("git", args, {
    cwd,
    env,
    timeout: 120_000,
    maxBuffer: 128 * 1024 * 1024,
    ...options,
  });
  operation.child.stdin?.end();
  return (await operation).stdout;
}

export async function preserveCloneBranches(cwd: string): Promise<void> {
  const branches = await git(cwd, [
    "for-each-ref",
    "--format=%(refname:strip=3) %(objectname)",
    "refs/remotes/origin/",
  ]);
  for (const entry of branches.trim().split("\n").filter(Boolean)) {
    const [name, commit] = entry.split(" ");
    if (name && name !== "HEAD" && commit)
      await git(cwd, ["update-ref", `refs/heads/${name}`, commit]);
  }
}
