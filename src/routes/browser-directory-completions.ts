import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import type {
  DirectoryCompletionItem,
  DirectoryCompletionsResponse,
} from "../contracts/control-surface-api.ts";
import { getOrCreate } from "../file-finder/manager.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { sendJson } from "./_shared.ts";

const MAX_ITEMS = 15;
const HIDDEN_PREFIXES = ["."];
const EXCLUDED_NAMES = new Set(["node_modules"]);

export async function handleBrowserDirectoryCompletionsRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const rawQuery = url.searchParams.get("query") ?? "";
  const streamId = url.searchParams.get("streamId");
  const baseCwd = await resolveBaseCwd(runtime, streamId);
  const directoryItems = await listDirectoryCompletionItems(baseCwd, rawQuery);

  const resolution = resolveRepoSearch(baseCwd, rawQuery);
  if (!resolution?.repoRoot || !resolution.searchTerm) {
    return sendJson(res, 200, {
      items: directoryItems,
      cwd: baseCwd,
      query: rawQuery,
    } satisfies DirectoryCompletionsResponse);
  }

  try {
    const finder = getOrCreate(resolution.repoRoot);
    const result = finder.fileSearch(resolution.searchTerm, { pageSize: MAX_ITEMS });
    if (!result.ok) {
      return sendJson(res, 200, {
        items: directoryItems,
        cwd: baseCwd,
        query: rawQuery,
      } satisfies DirectoryCompletionsResponse);
    }

    const fuzzyItems = result.value.items.map((item) =>
      toCompletionItem(path.join(resolution.repoRoot, item.relativePath), "file", baseCwd, rawQuery),
    );
    const items = mergeCompletionItems(directoryItems, fuzzyItems);
    return sendJson(res, 200, {
      items,
      cwd: baseCwd,
      query: rawQuery,
    } satisfies DirectoryCompletionsResponse);
  } catch {
    return sendJson(res, 200, {
      items: directoryItems,
      cwd: baseCwd,
      query: rawQuery,
    } satisfies DirectoryCompletionsResponse);
  }
}

async function listDirectoryCompletionItems(
  cwd: string,
  pathParam: string,
): Promise<DirectoryCompletionItem[]> {
  // Expand leading ~ to the user's home directory
  const isAbsolute = pathParam.startsWith("/");
  const isTilde = pathParam.startsWith("~");
  const expandedParam = isTilde
    ? os.homedir() + (pathParam.length === 1 ? "/" : pathParam.slice(1))
    : pathParam;

  // Split path into directory prefix and filter suffix
  const lastSlash = expandedParam.lastIndexOf("/");
  const dirPrefix = lastSlash >= 0 ? expandedParam.slice(0, lastSlash + 1) : "";
  const filter = lastSlash >= 0 ? expandedParam.slice(lastSlash + 1) : expandedParam;

  // Resolve and validate the target directory
  const targetDir = path.resolve(cwd, dirPrefix);

  // Security: allow explicit absolute paths and tilde-expanded paths.
  // For relative paths, ensure they don't escape the project directory via traversal.
  if (!isAbsolute && !isTilde && !targetDir.startsWith(cwd)) {
    return [];
  }

  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(targetDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const filterLower = filter.toLowerCase();

  const filtered = entries.filter((entry) => {
    if (HIDDEN_PREFIXES.some((p) => entry.name.startsWith(p))) return false;
    if (EXCLUDED_NAMES.has(entry.name)) return false;
    if (filterLower && !entry.name.toLowerCase().startsWith(filterLower)) return false;
    return true;
  });

  const dirs = filtered.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  const files = filtered
    .filter((e) => !e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  const sorted = [...dirs, ...files].slice(0, MAX_ITEMS);
  const displayPrefix = isTilde
    ? pathParam.slice(0, pathParam.lastIndexOf("/") + 1) || "~/"
    : dirPrefix;

  return sorted.map((entry) =>
    toCompletionItem(
      path.join(targetDir, entry.name),
      entry.isDirectory() ? "directory" : "file",
      cwd,
      rawPathForDisplay(pathParam, displayPrefix + entry.name + (entry.isDirectory() ? "/" : "")),
    ),
  );
}

function mergeCompletionItems(
  primary: DirectoryCompletionItem[],
  secondary: DirectoryCompletionItem[],
): DirectoryCompletionItem[] {
  const sorted = [
    ...primary.filter((item) => item.kind === "directory"),
    ...primary.filter((item) => item.kind !== "directory"),
    ...secondary,
  ];

  const merged: DirectoryCompletionItem[] = [];
  const seen = new Set<string>();

  for (const item of sorted) {
    if (seen.has(item.path)) continue;
    seen.add(item.path);
    merged.push(item);
    if (merged.length >= MAX_ITEMS) break;
  }

  return merged;
}

async function resolveBaseCwd(
  runtime: ControlSurfaceRuntime,
  streamId: string | null,
): Promise<string> {
  if (streamId) {
    const { getStreamById } = await import("../blackboard/query-streams.ts");
    const stream = getStreamById(runtime.blackboard, streamId);
    if (stream?.repo_path) return stream.repo_path;
  }
  const defaultPi = runtime.sessionManager.getDefault();
  return defaultPi ? runtime.config.projectsDir : process.cwd();
}

function resolveRepoSearch(
  baseCwd: string,
  rawQuery: string,
): { repoRoot: string; searchTerm: string } | null {
  const absoluteQuery = resolveAbsoluteQuery(baseCwd, rawQuery);
  const repoRoot = findDeepestGitRepo(absoluteQuery);
  if (!repoRoot) return null;
  const relativeToRepo = path.relative(repoRoot, absoluteQuery).replaceAll(path.sep, "/");
  const cleaned = relativeToRepo.replace(/^(\.\/|\/)+/, "").trim();
  if (!cleaned || cleaned === ".") return null;
  // Split into fff-node's "pathPrefix/ searchTerm" format:
  // "src/file-finder/smt" → "src/file-finder/ smt"
  const lastSlash = cleaned.lastIndexOf("/");
  const searchTerm =
    lastSlash >= 0 && cleaned.length > lastSlash + 1
      ? cleaned.slice(0, lastSlash + 1) + " " + cleaned.slice(lastSlash + 1)
      : cleaned;
  return { repoRoot, searchTerm };
}

function findDeepestGitRepo(absoluteQuery: string): string | null {
  let current = absoluteQuery;
  while (true) {
    if (hasGitDir(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function hasGitDir(candidate: string): boolean {
  try {
    return existsSync(path.join(candidate, ".git"));
  } catch {
    return false;
  }
}

function resolveAbsoluteQuery(baseCwd: string, rawQuery: string): string {
  if (!rawQuery) return baseCwd;
  if (rawQuery.startsWith("~")) {
    return path.resolve(os.homedir(), rawQuery.length === 1 ? "." : rawQuery.slice(2));
  }
  if (path.isAbsolute(rawQuery)) return path.resolve(rawQuery);
  return path.resolve(baseCwd, rawQuery);
}

function rawPathForDisplay(rawQuery: string, fallback: string): string {
  return rawQuery.startsWith("~") ? fallback.replace(os.homedir(), "~") : fallback;
}

function toCompletionItem(
  absolutePath: string,
  kind: "directory" | "file",
  baseCwd: string,
  rawQuery: string,
): DirectoryCompletionItem {
  const tokenPath = formatTokenPath(absolutePath, baseCwd, rawQuery, kind === "directory");
  return {
    name: path.basename(absolutePath),
    kind,
    path: tokenPath,
    insertText: tokenPath,
  };
}

function formatTokenPath(
  absolutePath: string,
  baseCwd: string,
  rawQuery: string,
  isDirectory: boolean,
): string {
  const normalized = absolutePath.replaceAll(path.sep, "/");
  let tokenPath: string;
  if (rawQuery.startsWith("~")) {
    const home = os.homedir().replaceAll(path.sep, "/");
    tokenPath = normalized.startsWith(home) ? `~${normalized.slice(home.length)}` || "~" : normalized;
  } else if (path.isAbsolute(rawQuery)) {
    tokenPath = normalized;
  } else {
    tokenPath = path.relative(baseCwd, absolutePath).replaceAll(path.sep, "/");
  }
  if (!tokenPath || tokenPath === ".") tokenPath = isDirectory ? "./" : ".";
  if (isDirectory && !tokenPath.endsWith("/")) tokenPath += "/";
  return tokenPath;
}
