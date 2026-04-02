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
  const mode = url.searchParams.get("mode");
  const root = url.searchParams.get("root");
  const streamId = url.searchParams.get("streamId");

  // Fuzzy file search mode via FileFinder
  if (mode === "fuzzy") {
    const filter = url.searchParams.get("path") ?? "";

    // Determine the repo root: explicit param, or look up from streamId
    let repoRoot = root;
    if (!repoRoot && streamId) {
      const { getStreamById } = await import("../blackboard/query-streams.ts");
      const stream = getStreamById(runtime.blackboard, streamId);
      repoRoot = stream?.repo_path ?? null;
    }

    if (!repoRoot) {
      return sendJson(res, 200, { items: [], cwd: "" } satisfies DirectoryCompletionsResponse);
    }

    const directoryItems = await listDirectoryCompletionItems(repoRoot, filter);

    // Empty filter: return directory completions only.
    if (!filter) {
      return sendJson(res, 200, {
        items: directoryItems,
        cwd: repoRoot,
      } satisfies DirectoryCompletionsResponse);
    }

    try {
      const finder = getOrCreate(repoRoot);
      const result = finder.fileSearch(filter, { pageSize: MAX_ITEMS });

      if (!result.ok) {
        return sendJson(
          res,
          200,
          { items: directoryItems, cwd: repoRoot } satisfies DirectoryCompletionsResponse,
        );
      }

      const fuzzyItems = result.value.items.map((item) => ({
        name: item.fileName,
        kind: "file" as const,
        path: item.relativePath,
      }));
      const items = mergeCompletionItems(directoryItems, fuzzyItems);

      return sendJson(res, 200, { items, cwd: repoRoot } satisfies DirectoryCompletionsResponse);
    } catch {
      return sendJson(
        res,
        200,
        { items: directoryItems, cwd: repoRoot } satisfies DirectoryCompletionsResponse,
      );
    }
  }

  // --- Existing directory completion mode (unchanged) ---
  const pathParam = url.searchParams.get("path") ?? "";

  // Resolve CWD from default Pi session's config, fallback to process.cwd()
  const defaultPi = runtime.sessionManager.getDefault();
  const cwd = defaultPi ? runtime.config.projectsDir : process.cwd();

  const empty: DirectoryCompletionsResponse = { items: [], cwd };

  const items = await listDirectoryCompletionItems(cwd, pathParam);

  return sendJson(res, 200, { items, cwd } satisfies DirectoryCompletionsResponse);
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

  return sorted.map((entry) => ({
    name: entry.name,
    kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
    path: displayPrefix + entry.name + (entry.isDirectory() ? "/" : ""),
  }));
}

function mergeCompletionItems(
  primary: DirectoryCompletionItem[],
  secondary: DirectoryCompletionItem[],
): DirectoryCompletionItem[] {
  const directories = primary.filter((item) => item.kind === "directory");
  const topRanked = [directories[0], secondary[0], secondary[1], directories[1], directories[2]].filter(
    (item): item is DirectoryCompletionItem => Boolean(item),
  );
  const remainder = [
    ...primary.filter((item) => item.kind !== "directory"),
    ...directories.slice(3),
    ...secondary.slice(2),
  ];

  const merged: DirectoryCompletionItem[] = [];
  const seen = new Set<string>();

  for (const item of [...topRanked, ...remainder]) {
    if (seen.has(item.path)) continue;
    seen.add(item.path);
    merged.push(item);
    if (merged.length >= MAX_ITEMS) break;
  }

  return merged;
}
