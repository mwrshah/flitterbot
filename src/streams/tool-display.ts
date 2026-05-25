/**
 * Tool path display formatting.
 *
 * Renders absolute (and `~`-prefixed) path-valued tool arguments as
 * stream-relative for the chat timeline UI, without ever mutating the
 * canonical tool `args` that are persisted, replayed, or fed back into
 * tools.
 *
 * Policy (whole-path args): try `worktree_path` first, then `cwd`. If
 * neither matches and the value is under the current user's `$HOME`,
 * abbreviate as `~/...`. Otherwise leave it alone.
 *
 * Policy (`bash.command`): rewrite absolute-path tokens against `cwd`
 * only, then conservative `$HOME` → `~/...`. We never use
 * `worktree_path` inside command strings because shell semantics make
 * worktree-relative rewriting potentially misleading (the command's
 * actual working directory is `cwd`).
 *
 * Cache: process-local `Map<piSessionId, ToolPathFormatter>`. The first
 * lookup runs a single SELECT against pi_sessions + streams; subsequent
 * lookups are O(1). Invalidate on worktree mutation; delete on session
 * teardown.
 */

import os from "node:os";
import path from "node:path";
import type { BlackboardDatabase } from "../blackboard/db.ts";
import type { ChatTimelineItem, ChatTimelineTool, JsonValue } from "../contracts/index.ts";

type JsonObject = { [key: string]: JsonValue };

export type ToolDisplayContext = {
  cwd?: string | null;
  worktreePath?: string | null;
  homeDir?: string | null;
};

export type ToolPathFormatter = {
  displayArgsForTool(toolName: string, args: unknown): JsonObject | undefined;
};

export type ToolDisplayContextCache = {
  formatterForPiSession(piSessionId: string): ToolPathFormatter;
  displayArgsForTool(piSessionId: string, toolName: string, args: unknown): JsonObject | undefined;
  invalidatePiSession(piSessionId: string): void;
  deletePiSession(piSessionId: string): void;
};

/* ── Path roots & normalization ───────────────────────────────────── */

/** Trim trailing separators (but keep "/" itself). */
function normalizeRoot(root: string | null | undefined): string | undefined {
  if (!root) return undefined;
  const trimmed = root.trim();
  if (!trimmed) return undefined;
  if (trimmed === "/") return "/";
  return trimmed.replace(/\/+$/, "");
}

function expandHome(value: string, homeDir: string | undefined): string | undefined {
  if (!homeDir) return undefined;
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return path.join(homeDir, value.slice(2));
  // `~user/...` — do not expand; semantics depend on the OS user db.
  return undefined;
}

function isAbsolute(value: string): boolean {
  return value.startsWith("/");
}

function isHomePrefixed(value: string): boolean {
  if (value === "~") return true;
  if (value.startsWith("~/")) return true;
  return false;
}

/**
 * Strict path-boundary downstream check. `/repo/foo` is NOT downstream of
 * `/repo/foobar` and vice versa. Equality returns `true` with empty remainder.
 */
function downstreamOf(absoluteValue: string, root: string): { match: boolean; remainder: string } {
  if (absoluteValue === root) return { match: true, remainder: "" };
  // Special-case root "/" so we don't double the leading slash.
  if (root === "/") {
    return { match: true, remainder: absoluteValue.slice(1) };
  }
  const prefix = `${root}/`;
  if (absoluteValue.startsWith(prefix)) {
    return { match: true, remainder: absoluteValue.slice(prefix.length) };
  }
  return { match: false, remainder: "" };
}

/* ── Display formatter ────────────────────────────────────────────── */

/**
 * Format a single whole-path value. Returns the formatted display string,
 * or `undefined` when no transformation applies (so callers can detect
 * "nothing changed" and skip emitting displayArgs).
 *
 * Tries roots in **policy order**: worktree first, then cwd. Falls back
 * to home abbreviation. A non-absolute, non-`~` value is returned as
 * `undefined` (we don't touch arbitrary relative strings).
 */
export function formatWholePathValue(value: string, ctx: ToolDisplayContext): string | undefined {
  if (!value) return undefined;
  const home = normalizeRoot(ctx.homeDir);

  let absolute: string | undefined;
  if (isAbsolute(value)) {
    absolute = value;
  } else if (isHomePrefixed(value)) {
    absolute = expandHome(value, home);
    if (!absolute) {
      // `~user/...` — leave the original spelling.
      return undefined;
    }
  } else {
    return undefined;
  }

  const roots: Array<string> = [];
  const worktree = normalizeRoot(ctx.worktreePath);
  const cwd = normalizeRoot(ctx.cwd);
  if (worktree) roots.push(worktree);
  if (cwd && cwd !== worktree) roots.push(cwd);

  for (const root of roots) {
    const { match, remainder } = downstreamOf(absolute, root);
    if (match) {
      if (remainder === "") return ".";
      return remainder;
    }
  }

  // No root match: try home abbreviation.
  if (home) {
    const { match, remainder } = downstreamOf(absolute, home);
    if (match) {
      return remainder === "" ? "~" : `~/${remainder}`;
    }
  }

  // The original was `~`/`~/...` and didn't match any configured root:
  // keep the original spelling (don't widen it back out to the expansion).
  if (isHomePrefixed(value)) return undefined;
  // Absolute outside any configured root: leave as-is.
  return undefined;
}

/**
 * Format absolute and `~/...` path tokens inside a `bash.command` string.
 * Conservative: only matches recognizable path tokens, only against `cwd`
 * (not worktree), and falls back to home abbreviation.
 */
export function formatBashCommand(command: string, ctx: ToolDisplayContext): string | undefined {
  if (!command) return undefined;
  const cwd = normalizeRoot(ctx.cwd);
  const home = normalizeRoot(ctx.homeDir);
  if (!cwd && !home) return undefined;

  // Match either an absolute path or a `~`/`~/...` token bounded by
  // whitespace or string ends. Path tokens may contain anything except
  // whitespace, quotes, or the shell metacharacters that would obviously
  // end the path. Quoted forms (`"/abs/..."`, `'/abs/...'`) are matched
  // by anchoring the match to the inner quote, but to stay conservative
  // we only rewrite the unquoted form here — quoted absolute paths are
  // rare in display copy and the canonical args are unchanged.
  const tokenRegex = /(^|[\s=:])((?:~(?:\/[^\s'"`]*)?|\/[^\s'"`]+))/g;

  let changed = false;
  const result = command.replace(tokenRegex, (_match, lead: string, token: string) => {
    let absolute: string | undefined;
    if (isAbsolute(token)) {
      absolute = token;
    } else if (isHomePrefixed(token)) {
      absolute = expandHome(token, home);
      if (!absolute) return `${lead}${token}`;
    } else {
      return `${lead}${token}`;
    }

    if (cwd) {
      const { match, remainder } = downstreamOf(absolute, cwd);
      if (match) {
        const replaced = remainder === "" ? "." : remainder;
        if (replaced !== token) changed = true;
        return `${lead}${replaced}`;
      }
    }

    if (home) {
      const { match, remainder } = downstreamOf(absolute, home);
      if (match) {
        const replaced = remainder === "" ? "~" : `~/${remainder}`;
        if (replaced !== token) changed = true;
        return `${lead}${replaced}`;
      }
    }

    return `${lead}${token}`;
  });

  return changed ? result : undefined;
}

/* ── Tool/key map ─────────────────────────────────────────────────── */

/**
 * Keys per built-in tool that hold a whole-path string. We only touch
 * known path-valued fields — never a generic walk of the args object.
 */
const WHOLE_PATH_KEYS: Record<string, readonly string[]> = {
  read: ["path", "file_path", "filePath"],
  edit: ["path", "file_path", "filePath"],
  write: ["path", "file_path", "filePath"],
  grep: ["path"],
  ls: ["path", "directory"],
  // For glob, `path` and `directory` are paths; `pattern` is only touched
  // when it starts with an absolute root — we treat that case in code.
  glob: ["path", "directory"],
};

function tryFormatWholePathField(
  args: Record<string, unknown>,
  key: string,
  ctx: ToolDisplayContext,
): { changed: boolean; value: JsonValue } {
  const raw = args[key];
  if (typeof raw !== "string") {
    return { changed: false, value: (raw ?? null) as JsonValue };
  }
  const formatted = formatWholePathValue(raw, ctx);
  if (formatted === undefined || formatted === raw) {
    return { changed: false, value: raw };
  }
  return { changed: true, value: formatted };
}

/* ── Public formatter ─────────────────────────────────────────────── */

export function createToolPathFormatter(ctx: ToolDisplayContext): ToolPathFormatter {
  return {
    displayArgsForTool(toolName, args) {
      if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
      const argRecord = args as Record<string, unknown>;
      const name = toolName.toLowerCase();

      if (name === "bash") {
        const command = argRecord.command;
        if (typeof command !== "string") return undefined;
        const formatted = formatBashCommand(command, ctx);
        if (formatted === undefined) return undefined;
        return { ...(argRecord as JsonObject), command: formatted };
      }

      if (name === "glob") {
        // Format path/directory normally; treat pattern only if it looks
        // like an absolute or `~` rooted path.
        const out: JsonObject = { ...(argRecord as JsonObject) };
        let changed = false;
        for (const key of WHOLE_PATH_KEYS.glob ?? []) {
          const res = tryFormatWholePathField(argRecord, key, ctx);
          if (res.changed) {
            out[key] = res.value;
            changed = true;
          }
        }
        const pattern = argRecord.pattern;
        if (typeof pattern === "string" && (isAbsolute(pattern) || isHomePrefixed(pattern))) {
          const formatted = formatWholePathValue(pattern, ctx);
          if (formatted !== undefined && formatted !== pattern) {
            out.pattern = formatted;
            changed = true;
          }
        }
        return changed ? out : undefined;
      }

      const keys = WHOLE_PATH_KEYS[name];
      if (!keys) return undefined;

      const out: JsonObject = { ...(argRecord as JsonObject) };
      let changed = false;
      for (const key of keys) {
        const res = tryFormatWholePathField(argRecord, key, ctx);
        if (res.changed) {
          out[key] = res.value;
          changed = true;
        }
      }
      return changed ? out : undefined;
    },
  };
}

/* ── Blackboard context lookup ───────────────────────────────────── */

type PiSessionContextRow = {
  cwd: string | null;
  worktree_path: string | null;
};

export function getToolDisplayContextForPiSession(
  blackboard: BlackboardDatabase,
  piSessionId: string,
): ToolDisplayContext {
  const row = blackboard
    .prepare(
      `SELECT ps.cwd AS cwd, s.worktree_path AS worktree_path
         FROM pi_sessions ps
         LEFT JOIN streams s ON s.id = ps.stream_id
        WHERE ps.pi_session_id = ?`,
    )
    .get(piSessionId) as PiSessionContextRow | undefined;

  return {
    cwd: row?.cwd ?? null,
    worktreePath: row?.worktree_path ?? null,
    homeDir: os.homedir() || process.env.HOME || null,
  };
}

/* ── Cache ────────────────────────────────────────────────────────── */

export function createToolDisplayContextCache(
  blackboard: BlackboardDatabase,
): ToolDisplayContextCache {
  const formatters = new Map<string, ToolPathFormatter>();

  function getFormatter(piSessionId: string): ToolPathFormatter {
    let formatter = formatters.get(piSessionId);
    if (!formatter) {
      const ctx = getToolDisplayContextForPiSession(blackboard, piSessionId);
      formatter = createToolPathFormatter(ctx);
      formatters.set(piSessionId, formatter);
    }
    return formatter;
  }

  return {
    formatterForPiSession(piSessionId) {
      return getFormatter(piSessionId);
    },
    displayArgsForTool(piSessionId, toolName, args) {
      return getFormatter(piSessionId).displayArgsForTool(toolName, args);
    },
    invalidatePiSession(piSessionId) {
      formatters.delete(piSessionId);
    },
    deletePiSession(piSessionId) {
      formatters.delete(piSessionId);
    },
  };
}

/* ── History enrichment ─────────────────────────────────────────── */

/**
 * Walk a history items list and stamp `displayArgs` on every tool item
 * with `phase` "start" or "update" whose canonical `args` contains
 * something we can rewrite for display. Pure with respect to the input
 * items (clones any touched tool item; reuses untouched references).
 *
 * Centralized helper used by `browser-streams.ts` so both the live and
 * disk-fallback branches enrich identically.
 */
export function enrichTimelineToolDisplays(
  items: ChatTimelineItem[],
  formatter: ToolPathFormatter,
): ChatTimelineItem[] {
  let changed = false;
  const out: ChatTimelineItem[] = new Array(items.length);
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.kind !== "tool" || (item.phase !== "start" && item.phase !== "update")) {
      out[i] = item;
      continue;
    }
    const tool = item as ChatTimelineTool;
    if (tool.args === undefined || tool.displayArgs !== undefined) {
      out[i] = item;
      continue;
    }
    const display = formatter.displayArgsForTool(tool.tool, tool.args);
    if (!display) {
      out[i] = item;
      continue;
    }
    out[i] = { ...tool, displayArgs: display as JsonValue };
    changed = true;
  }
  return changed ? out : items;
}
