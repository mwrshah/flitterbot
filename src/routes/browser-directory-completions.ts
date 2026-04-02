import { readdir } from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import type { DirectoryCompletionsResponse } from "../contracts/control-surface-api.ts";
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

    // Empty filter: return empty (frontend shows first-level dirs via directory mode)
    if (!filter) {
      return sendJson(
        res,
        200,
        { items: [], cwd: repoRoot } satisfies DirectoryCompletionsResponse,
      );
    }

    try {
      const finder = getOrCreate(repoRoot);
      const result = finder.fileSearch(filter, { pageSize: MAX_ITEMS });

      if (!result.ok) {
        return sendJson(
          res,
          200,
          { items: [], cwd: repoRoot } satisfies DirectoryCompletionsResponse,
        );
      }

      const items = result.value.items.map((item) => ({
        name: item.fileName,
        kind: "file" as const,
        path: item.relativePath,
      }));

      return sendJson(res, 200, { items, cwd: repoRoot } satisfies DirectoryCompletionsResponse);
    } catch {
      return sendJson(
        res,
        200,
        { items: [], cwd: repoRoot } satisfies DirectoryCompletionsResponse,
      );
    }
  }

  // --- Existing directory completion mode (unchanged) ---
  const pathParam = url.searchParams.get("path") ?? "";

  // Resolve CWD from default Pi session's config, fallback to process.cwd()
  const defaultPi = runtime.sessionManager.getDefault();
  const cwd = defaultPi ? runtime.config.projectsDir : process.cwd();

  const empty: DirectoryCompletionsResponse = { items: [], cwd };

  // Expand leading ~ to the user's home directory
  const isAbsolute = pathParam.startsWith("/");
  const isTilde = pathParam.startsWith("~");
  const expandedParam = isTilde
    ? os.homedir() + (pathParam.length === 1 ? "/" : pathParam.slice(1)) // ~ → /home/user/, ~/foo → /home/user/foo
    : pathParam;

  // Split path into directory prefix and filter suffix
  // e.g. "src/ro" → dir="src/", filter="ro"
  // e.g. "src/"   → dir="src/", filter=""
  // e.g. ""       → dir="",     filter=""
  const lastSlash = expandedParam.lastIndexOf("/");
  const dirPrefix = lastSlash >= 0 ? expandedParam.slice(0, lastSlash + 1) : "";
  const filter = lastSlash >= 0 ? expandedParam.slice(lastSlash + 1) : expandedParam;

  // Resolve and validate the target directory
  const targetDir = path.resolve(cwd, dirPrefix);

  // Security: allow explicit absolute paths and tilde-expanded paths.
  // For relative paths, ensure they don't escape the project directory via traversal.
  if (!isAbsolute && !isTilde && !targetDir.startsWith(cwd)) {
    return sendJson(res, 200, empty);
  }

  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(targetDir, { withFileTypes: true });
  } catch {
    return sendJson(res, 200, empty);
  }

  const filterLower = filter.toLowerCase();

  const filtered = entries.filter((entry) => {
    // Exclude hidden entries
    if (HIDDEN_PREFIXES.some((p) => entry.name.startsWith(p))) return false;
    // Exclude node_modules
    if (EXCLUDED_NAMES.has(entry.name)) return false;
    // Case-insensitive prefix match
    if (filterLower && !entry.name.toLowerCase().startsWith(filterLower)) return false;
    return true;
  });

  // Sort: directories first (alphabetical), then files (alphabetical)
  const dirs = filtered.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  const files = filtered
    .filter((e) => !e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  const sorted = [...dirs, ...files].slice(0, MAX_ITEMS);

  // For tilde paths, return items with the original ~/ prefix so ~ stays in the UX.
  const displayPrefix = isTilde
    ? pathParam.slice(0, pathParam.lastIndexOf("/") + 1) || "~/"
    : dirPrefix;
  const items = sorted.map((entry) => ({
    name: entry.name,
    kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
    path: displayPrefix + entry.name + (entry.isDirectory() ? "/" : ""),
  }));

  return sendJson(res, 200, { items, cwd } satisfies DirectoryCompletionsResponse);
}
