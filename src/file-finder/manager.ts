import path from "node:path";
import { FileFinder } from "@ff-labs/fff-node";

export const FILE_FINDER_MAX_FILE_SIZE = 32 * 1024 * 1024;

const instances = new Map<string, FileFinder>();
const leaseCounts = new Map<string, number>();
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

export function getOrCreate(
  basePath: string,
  onCreateStart?: (basePath: string) => void,
): FileFinder {
  const normalized = path.resolve(basePath);

  const existing = instances.get(normalized);
  if (existing && !existing.isDestroyed) {
    instances.delete(normalized);
    instances.set(normalized, existing);
    return existing;
  }

  onCreateStart?.(normalized);
  const result = FileFinder.create({
    basePath: normalized,
    aiMode: true,
    cacheBudgetMaxFileSize: FILE_FINDER_MAX_FILE_SIZE,
  });
  if (!result.ok) {
    throw new Error(`Failed to create FileFinder for ${normalized}: ${result.error}`);
  }

  const finder = result.value;
  instances.set(normalized, finder);
  evictIfNeeded();

  return finder;
}

export async function withFileFinder<T>(
  basePath: string,
  operation: (finder: FileFinder) => Promise<T>,
  onCreateStart?: (basePath: string) => void,
): Promise<T> {
  const normalized = path.resolve(basePath);
  leaseCounts.set(normalized, (leaseCounts.get(normalized) ?? 0) + 1);
  try {
    return await operation(getOrCreate(normalized, onCreateStart));
  } finally {
    const remaining = (leaseCounts.get(normalized) ?? 1) - 1;
    if (remaining === 0) leaseCounts.delete(normalized);
    else leaseCounts.set(normalized, remaining);
    evictIfNeeded();
  }
}

export function destroyAll(): void {
  for (const [key, finder] of instances) {
    if (!finder.isDestroyed) finder.destroy();
    instances.delete(key);
  }
  leaseCounts.clear();
}

function evictIfNeeded(): void {
  while (instances.size > MAX_INSTANCES) {
    const oldestKey = [...instances.keys()].find((key) => !leaseCounts.has(key));
    if (!oldestKey) return;
    const oldest = instances.get(oldestKey);
    if (oldest && !oldest.isDestroyed) oldest.destroy();
    instances.delete(oldestKey);
  }
}
