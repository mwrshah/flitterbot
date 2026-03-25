import { useEffect, useRef } from "react";

// ── Types ──

type ChangeKind = "REF_ONLY" | "VALUE";

interface ChangeSummary {
  kind: ChangeKind;
  detail: string;
}

interface WdyrConfig {
  include?: string[];
  exclude?: string[];
  onlyRefChanges?: boolean;
  verbose?: boolean;
}

declare global {
  interface Window {
    __WDYR_CONFIG?: WdyrConfig;
  }
}

// ── Change classification ──

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function formatPrimitive(v: unknown): string {
  if (typeof v === "string") return `"${truncate(v, 40)}"`;
  return String(v);
}

function classifyChange(prev: unknown, next: unknown): ChangeSummary {
  // null/undefined transitions
  if (prev == null || next == null) {
    return { kind: "VALUE", detail: `${formatPrimitive(prev)}→${formatPrimitive(next)}` };
  }

  // Primitives (number, string, boolean, bigint, symbol)
  if (typeof prev !== "object" && typeof prev !== "function") {
    return { kind: "VALUE", detail: `${formatPrimitive(prev)}→${formatPrimitive(next)}` };
  }

  // Functions — always ref-only
  if (typeof prev === "function" || typeof next === "function") {
    return { kind: "REF_ONLY", detail: "fn" };
  }

  // Sets
  if (prev instanceof Set && next instanceof Set) {
    if (prev.size !== next.size) {
      return { kind: "VALUE", detail: `Set(${prev.size}→${next.size})` };
    }
    for (const v of prev) {
      if (!next.has(v)) return { kind: "VALUE", detail: `Set(${prev.size}) members differ` };
    }
    return { kind: "REF_ONLY", detail: `Set(${prev.size}) identical` };
  }

  // Arrays
  if (Array.isArray(prev) && Array.isArray(next)) {
    const pLen = prev.length;
    const nLen = next.length;
    const minLen = Math.min(pLen, nLen);
    const changed: number[] = [];

    for (let i = 0; i < minLen; i++) {
      if (!Object.is(prev[i], next[i])) {
        changed.push(i);
        if (changed.length > 5) break; // cap for perf
      }
    }

    if (pLen === nLen && changed.length === 0) {
      return { kind: "REF_ONLY", detail: `Array(${pLen}) identical` };
    }
    if (changed.length === 0 && nLen > pLen) {
      return { kind: "VALUE", detail: `Array(${pLen}→${nLen}) +${nLen - pLen} at end` };
    }
    if (changed.length === 0 && nLen < pLen) {
      return { kind: "VALUE", detail: `Array(${pLen}→${nLen}) -${pLen - nLen} from end` };
    }
    const idxStr = changed.length > 5
      ? `[${changed.slice(0, 5).join(",")},...] changed`
      : `[${changed.join(",")}] changed`;
    const lenPart = pLen !== nLen ? `(${pLen}→${nLen})` : `(${pLen})`;
    return { kind: "VALUE", detail: `Array${lenPart} ${idxStr}` };
  }

  // Plain objects
  if (typeof prev === "object" && typeof next === "object") {
    const prevObj = prev as Record<string, unknown>;
    const nextObj = next as Record<string, unknown>;
    const prevKeys = Object.keys(prevObj);
    const nextKeys = Object.keys(nextObj);
    const prevSet = new Set(prevKeys);
    const nextSet = new Set(nextKeys);

    const added = nextKeys.filter((k) => !prevSet.has(k));
    const removed = prevKeys.filter((k) => !nextSet.has(k));
    const common = prevKeys.filter((k) => nextSet.has(k));
    const changed = common.filter((k) => !Object.is(prevObj[k], nextObj[k]));
    const same = common.length - changed.length;

    if (added.length === 0 && removed.length === 0 && changed.length === 0) {
      return { kind: "REF_ONLY", detail: `{${prevKeys.length} keys} identical` };
    }

    const parts: string[] = [];
    if (changed.length > 0) {
      const changedStr = changed.length > 4
        ? `${changed.slice(0, 4).join(",")},…`
        : changed.join(",");
      parts.push(`{${changedStr}} changed`);
    }
    if (added.length > 0) parts.push(`+{${added.join(",")}}`);
    if (removed.length > 0) parts.push(`-{${removed.join(",")}}`);
    if (same > 0) parts.push(`${same} same`);
    return { kind: "VALUE", detail: parts.join(", ") };
  }

  // Fallback
  return { kind: "VALUE", detail: "changed" };
}

// ── Config reader ──

function getConfig(): WdyrConfig {
  return (typeof window !== "undefined" && window.__WDYR_CONFIG) || {};
}

function shouldLog(componentName: string, kind: ChangeKind): boolean {
  const cfg = getConfig();
  if (cfg.include && cfg.include.length > 0 && !cfg.include.includes(componentName)) return false;
  if (cfg.exclude && cfg.exclude.includes(componentName)) return false;
  if (cfg.onlyRefChanges && kind !== "REF_ONLY") return false;
  return true;
}

// ── Hook implementation ──

function useWhyDidYouRenderImpl(componentName: string, trackedValues: Record<string, unknown>): void {
  const prevRef = useRef<Record<string, unknown>>(trackedValues);

  useEffect(() => {
    const prev = prevRef.current;
    const allKeys = new Set([...Object.keys(prev), ...Object.keys(trackedValues)]);
    const verbose = getConfig().verbose ?? false;

    for (const key of allKeys) {
      if (!Object.is(prev[key], trackedValues[key])) {
        const summary = classifyChange(prev[key], trackedValues[key]);
        if (!shouldLog(componentName, summary.kind)) continue;

        let line = `[WDYR] ${componentName}.${key} ${summary.kind} | ${summary.detail}`;
        if (verbose) {
          try {
            const preview = JSON.stringify(trackedValues[key]);
            line += ` | ${truncate(preview, 80)}`;
          } catch {
            // non-serializable — skip preview
          }
        }
        console.log(line);
      }
    }

    prevRef.current = trackedValues;
  });
}

function noop(_componentName: string, _trackedValues: Record<string, unknown>): void {}

export const useWhyDidYouRender: (
  componentName: string,
  trackedValues: Record<string, unknown>,
) => void = import.meta.env.DEV ? useWhyDidYouRenderImpl : noop;
