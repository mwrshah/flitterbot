import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import type {
  DirectoryCompletionItem,
  DirectoryCompletionsResponse,
} from "../contracts/control-surface-api.ts";
import {
  getOrCreate,
  isFileFinderExcludedName,
  isFileFinderExcludedPath,
} from "../file-finder/manager.ts";
import type { ControlSurfaceRuntime } from "../runtime.ts";
import { sendJson } from "./_shared.ts";

const MAX_ITEMS = 15;

export async function handleBrowserDirectoryCompletionsRoute(
  runtime: ControlSurfaceRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const rawQuery = url.searchParams.get("query") ?? "";
  const streamId = url.searchParams.get("streamId");
  const directoriesOnly = url.searchParams.get("directoriesOnly") === "true";
  const baseCwd = await resolveBaseCwd(runtime, streamId);
  const directoryItems = await listDirectoryCompletionItems(baseCwd, rawQuery, directoriesOnly);

  const resolution = resolveRepoSearch(baseCwd, rawQuery);
  if (directoriesOnly || !resolution?.repoRoot || !resolution.searchTerm) {
    runtime.log(
      `[@] directory query="${rawQuery}" cwd=${baseCwd} → ${directoryItems.length} items`,
    );
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

    const spaceIdx = resolution.searchTerm.lastIndexOf(" ");
    const pathPrefix = spaceIdx >= 0 ? resolution.searchTerm.slice(0, spaceIdx) : "";
    const pureTerm =
      spaceIdx >= 0 ? resolution.searchTerm.slice(spaceIdx + 1) : resolution.searchTerm;
    const prefixDepth = pathPrefix ? pathPrefix.split("/").filter(Boolean).length : 0;
    const termLower = pureTerm.toLowerCase();
    const searchableItems = result.value.items.filter(
      (item) => !isFileFinderExcludedPath(item.relativePath),
    );
    const seenDirs = new Set<string>();
    const startsWithDirItems: DirectoryCompletionItem[] = [];
    const containsDirItems: DirectoryCompletionItem[] = [];
    for (const item of searchableItems) {
      const parts = item.relativePath.split("/");
      for (let i = prefixDepth; i < parts.length - 1; i++) {
        const segLower = parts[i]!.toLowerCase();
        if (!segLower.includes(termLower)) continue;
        const dirRel = parts.slice(0, i + 1).join("/");
        if (seenDirs.has(dirRel)) continue;
        seenDirs.add(dirRel);
        const completionItem = toCompletionItem(
          path.join(resolution.repoRoot, dirRel),
          "directory",
          baseCwd,
          rawQuery,
        );
        if (segLower.startsWith(termLower)) {
          startsWithDirItems.push(completionItem);
        } else {
          containsDirItems.push(completionItem);
        }
      }
    }
    const matchingDirItems = [...startsWithDirItems, ...containsDirItems];

    const fuzzyFileItems = searchableItems.map((item) =>
      toCompletionItem(
        path.join(resolution.repoRoot, item.relativePath),
        "file",
        baseCwd,
        rawQuery,
      ),
    );
    const fuzzyItems = [...matchingDirItems, ...fuzzyFileItems].slice(0, MAX_ITEMS);
    const items = mergeCompletionItems(directoryItems, fuzzyItems);
    runtime.log(
      `[@] fuzzy query="${rawQuery}" repo=${path.basename(resolution.repoRoot)} term="${resolution.searchTerm}" → ${fuzzyFileItems.length} files + ${matchingDirItems.length} dirs (+ ${directoryItems.length} fallback)`,
    );
    return sendJson(res, 200, {
      items,
      cwd: baseCwd,
      query: rawQuery,
    } satisfies DirectoryCompletionsResponse);
  } catch (err) {
    runtime.log(
      `[@] fuzzy error repo=${path.basename(resolution.repoRoot)} term="${resolution.searchTerm}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return sendJson(res, 200, {
      items: directoryItems,
      cwd: baseCwd,
      query: rawQuery,
    } satisfies DirectoryCompletionsResponse);
  }
}

function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function listDirectoryCompletionItems(
  cwd: string,
  pathParam: string,
  directoriesOnly = false,
): Promise<DirectoryCompletionItem[]> {
  const isAbsolute = pathParam.startsWith("/");
  const isTilde = pathParam.startsWith("~");
  const expandedParam = isTilde
    ? os.homedir() + (pathParam.length === 1 ? "/" : pathParam.slice(1))
    : pathParam;

  const lastSlash = expandedParam.lastIndexOf("/");
  const dirPrefix = lastSlash >= 0 ? expandedParam.slice(0, lastSlash + 1) : "";
  const filter = lastSlash >= 0 ? expandedParam.slice(lastSlash + 1) : expandedParam;

  if (isFileFinderExcludedPath(dirPrefix)) return [];

  const targetDir = path.resolve(cwd, dirPrefix);

  if (!isAbsolute && !isTilde) {
    const isParentTraversal = pathParam === ".." || pathParam.startsWith("../");
    if (isParentTraversal) {
      if (!isUnder(targetDir, os.homedir())) return [];
    } else if (!isUnder(targetDir, cwd)) {
      return [];
    }
  }

  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(targetDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const filterLower = filter.toLowerCase();

  type Tagged = { entry: import("node:fs").Dirent; startsWith: boolean };
  const filtered: Tagged[] = [];
  for (const entry of entries) {
    if (isFileFinderExcludedName(entry.name)) continue;
    if (!filterLower) {
      filtered.push({ entry, startsWith: true });
      continue;
    }
    const nameLower = entry.name.toLowerCase();
    if (!nameLower.includes(filterLower)) continue;
    filtered.push({ entry, startsWith: nameLower.startsWith(filterLower) });
  }

  const cmp = (a: Tagged, b: Tagged) => {
    if (a.startsWith !== b.startsWith) return a.startsWith ? -1 : 1;
    return a.entry.name.localeCompare(b.entry.name);
  };
  const dirs = filtered.filter((t) => t.entry.isDirectory()).sort(cmp);
  const files = directoriesOnly ? [] : filtered.filter((t) => !t.entry.isDirectory()).sort(cmp);

  const sorted = [...dirs, ...files].slice(0, MAX_ITEMS).map((t) => t.entry);
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
  if (rawQuery.endsWith("/")) return null;

  const absoluteQuery = resolveAbsoluteQuery(baseCwd, rawQuery);
  const repoRoot = findDeepestGitRepo(absoluteQuery);
  if (!repoRoot) return null;
  const relativeToRepo = path.relative(repoRoot, absoluteQuery).replaceAll(path.sep, "/");
  const cleaned = relativeToRepo.replace(/^(\.\/|\/)+/, "").trim();
  if (!cleaned || cleaned === ".") return null;
  const lastSlash = cleaned.lastIndexOf("/");
  const searchTerm =
    lastSlash >= 0 && cleaned.length > lastSlash + 1
      ? `${cleaned.slice(0, lastSlash + 1)} ${cleaned.slice(lastSlash + 1)}`
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
    tokenPath = normalized.startsWith(home)
      ? `~${normalized.slice(home.length)}` || "~"
      : normalized;
  } else if (path.isAbsolute(rawQuery)) {
    tokenPath = normalized;
  } else {
    tokenPath = path.relative(baseCwd, absolutePath).replaceAll(path.sep, "/");
  }
  if (!tokenPath || tokenPath === ".") tokenPath = isDirectory ? "./" : ".";
  if (isDirectory && !tokenPath.endsWith("/")) tokenPath += "/";
  return tokenPath;
}
