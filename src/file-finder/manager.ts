import fs from "node:fs";
import path from "node:path";
import { FileFinder } from "@ff-labs/fff-node";

const instances = new Map<string, FileFinder>();
const MAX_INSTANCES = 8;

/**
 * Get or create a FileFinder instance for a given repo root.
 * One instance per repo root, reused across requests.
 */
export function getOrCreate(repoRoot: string): FileFinder {
  const normalized = path.resolve(repoRoot);

  const existing = instances.get(normalized);
  if (existing && !existing.isDestroyed) {
    // Refresh insertion order so the map acts as a simple LRU cache.
    instances.delete(normalized);
    instances.set(normalized, existing);
    return existing;
  }

  // Validate it's a git repo
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

  // Warm up scan in background — don't block
  finder.waitForScan(5000).catch(() => {});

  return finder;
}

/**
 * Destroy all FileFinder instances. Call on runtime shutdown.
 */
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
