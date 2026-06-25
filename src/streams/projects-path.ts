import os from "node:os";
import path from "node:path";

export function relativizeProjectsPath(absolutePath: string, projectsDir: string): string {
  const rel = path.relative(projectsDir, absolutePath);
  if (!rel || rel.startsWith("..")) return homeify(absolutePath);
  return `../${rel}`;
}

function homeify(absolutePath: string): string {
  const home = os.homedir();
  if (absolutePath === home) return "~";
  if (absolutePath.startsWith(`${home}/`)) return `~/${absolutePath.slice(home.length + 1)}`;
  return absolutePath;
}
