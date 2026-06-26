import fs from "node:fs";
import path from "node:path";
import { FileFinder } from "@ff-labs/fff-node";

// ponytail: revisit whether this process needs an LRU of file finders; a single finder per active repo may be enough.
const instances = new Map<string, FileFinder>();
const MAX_INSTANCES = 8;
const ENV_FILE_PREFIX = ".env";
const EXCLUDED_EXACT_PATH_SEGMENTS = new Set([".git", ".github"]);

export function isFileFinderExcludedName(name: string): boolean {
  return name.startsWith(ENV_FILE_PREFIX) || EXCLUDED_EXACT_PATH_SEGMENTS.has(name);
}

export function isFileFinderExcludedPath(candidatePath: string): boolean {
  return candidatePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .some((segment) => isFileFinderExcludedName(segment));
}

export function getOrCreate(repoRoot: string): FileFinder {
  const normalized = path.resolve(repoRoot);

  const existing = instances.get(normalized);
  if (existing && !existing.isDestroyed) {
    // Refresh insertion order so the map acts as a simple LRU cache.
    instances.delete(normalized);
    instances.set(normalized, existing);
    return existing;
  }

  if (!fs.existsSync(path.join(normalized, ".git"))) {
    throw new Error(`Not a git repository: ${normalized}`);
  }

  const result = FileFinder.create({ basePath: normalized, aiMode: true });
  if (!result.ok) {
    throw new Error(`Failed to create FileFinder for ${normalized}: ${result.error}`);
  }

  const finder = result.value;
  instances.set(normalized, finder);
  evictIfNeeded();

  finder.waitForScan(5000).catch(() => {});

  return finder;
}

export function destroyAll(): void {
  for (const [key, finder] of instances) {
    if (!finder.isDestroyed) finder.destroy();
    instances.delete(key);
  }
}

function evictIfNeeded(): void {
  while (instances.size > MAX_INSTANCES) {
    const oldestKey = instances.keys().next().value;
    if (!oldestKey) return;
    const oldest = instances.get(oldestKey);
    if (oldest && !oldest.isDestroyed) oldest.destroy();
    instances.delete(oldestKey);
  }
}
