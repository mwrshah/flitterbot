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

function downstreamOf(absoluteValue: string, root: string): { match: boolean; remainder: string } {
  if (absoluteValue === root) return { match: true, remainder: "" };
  if (root === "/") {
    return { match: true, remainder: absoluteValue.slice(1) };
  }
  const prefix = `${root}/`;
  if (absoluteValue.startsWith(prefix)) {
    return { match: true, remainder: absoluteValue.slice(prefix.length) };
  }
  return { match: false, remainder: "" };
}

export function formatWholePathValue(value: string, ctx: ToolDisplayContext): string | undefined {
  if (!value) return undefined;
  const home = normalizeRoot(ctx.homeDir);

  let absolute: string | undefined;
  if (isAbsolute(value)) {
    absolute = value;
  } else if (isHomePrefixed(value)) {
    absolute = expandHome(value, home);
    if (!absolute) {
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

  if (home) {
    const { match, remainder } = downstreamOf(absolute, home);
    if (match) {
      return remainder === "" ? "~" : `~/${remainder}`;
    }
  }

  if (isHomePrefixed(value)) return undefined;
  return undefined;
}

export function formatBashCommand(command: string, ctx: ToolDisplayContext): string | undefined {
  if (!command) return undefined;
  const cwd = normalizeRoot(ctx.cwd);
  const home = normalizeRoot(ctx.homeDir);
  if (!cwd && !home) return undefined;

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

const WHOLE_PATH_KEYS: Record<string, readonly string[]> = {
  read: ["path", "file_path", "filePath"],
  edit: ["path", "file_path", "filePath"],
  write: ["path", "file_path", "filePath"],
  grep: ["path"],
  ls: ["path", "directory"],
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
