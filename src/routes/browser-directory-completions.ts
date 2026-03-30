import { readdir } from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import type { DirectoryCompletionsResponse } from "../contracts/control-surface-api.ts";
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
  const pathParam = url.searchParams.get("path") ?? "";

  // Resolve CWD from default Pi session's config, fallback to process.cwd()
  const defaultPi = runtime.sessionManager.getDefault();
  const cwd = defaultPi ? runtime.config.projectsDir : process.cwd();

  const empty: DirectoryCompletionsResponse = { items: [], cwd };

  // Split path into directory prefix and filter suffix
  // e.g. "src/ro" → dir="src/", filter="ro"
  // e.g. "src/"   → dir="src/", filter=""
  // e.g. ""       → dir="",     filter=""
  const lastSlash = pathParam.lastIndexOf("/");
  const dirPrefix = lastSlash >= 0 ? pathParam.slice(0, lastSlash + 1) : "";
  const filter = lastSlash >= 0 ? pathParam.slice(lastSlash + 1) : pathParam;

  // Resolve and validate the target directory
  const targetDir = path.resolve(cwd, dirPrefix);
  if (!targetDir.startsWith(cwd)) {
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

  const items = sorted.map((entry) => ({
    name: entry.name,
    kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
    path: dirPrefix + entry.name + (entry.isDirectory() ? "/" : ""),
  }));

  return sendJson(res, 200, { items, cwd } satisfies DirectoryCompletionsResponse);
}
