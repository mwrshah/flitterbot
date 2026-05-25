import { describe, expect, test } from "bun:test";
import type { ChatTimelineItem } from "../contracts/index.ts";
import {
  createToolPathFormatter,
  enrichTimelineToolDisplays,
  formatBashCommand,
  formatWholePathValue,
  type ToolDisplayContext,
} from "./tool-display.ts";

const WORKTREE = "/repo-worktrees/195-relative-tool-paths-doc";
const CWD = "/repo-worktrees/195-relative-tool-paths-doc/src";
const HOME = "/Users/munawarshah";

const ctx: ToolDisplayContext = {
  worktreePath: WORKTREE,
  cwd: CWD,
  homeDir: HOME,
};

describe("formatWholePathValue", () => {
  test("worktree root wins over deeper cwd", () => {
    const result = formatWholePathValue(`${WORKTREE}/src/streams/pi-subscribe.ts`, ctx);
    expect(result).toBe("src/streams/pi-subscribe.ts");
  });

  test("path under cwd that is also under worktree picks worktree", () => {
    const result = formatWholePathValue(`${CWD}/streams/x.ts`, ctx);
    expect(result).toBe("src/streams/x.ts");
  });

  test("cwd-only when no worktree", () => {
    const result = formatWholePathValue(`${CWD}/streams/x.ts`, {
      cwd: CWD,
      worktreePath: null,
      homeDir: HOME,
    });
    expect(result).toBe("streams/x.ts");
  });

  test("absolute outside worktree but under home becomes ~/...", () => {
    const result = formatWholePathValue(`${HOME}/Documents/notes.md`, ctx);
    expect(result).toBe("~/Documents/notes.md");
  });

  test("absolute outside home stays absolute", () => {
    expect(formatWholePathValue("/usr/local/bin/zsh", ctx)).toBeUndefined();
  });

  test("relative path is left unchanged", () => {
    expect(formatWholePathValue("src/foo.ts", ctx)).toBeUndefined();
  });

  test("relative string containing worktree directory name stays unchanged", () => {
    // "195-relative-tool-paths-doc" appears literally inside the worktree
    // root — the value must not be mis-stripped because it is not absolute.
    expect(formatWholePathValue("195-relative-tool-paths-doc/x.ts", ctx)).toBeUndefined();
  });

  test("~/... that expands under worktree shows worktree-relative", () => {
    // Pretend the worktree lives inside home for this case.
    const homeCtx: ToolDisplayContext = {
      worktreePath: `${HOME}/projects/wt`,
      cwd: `${HOME}/projects/wt/src`,
      homeDir: HOME,
    };
    const result = formatWholePathValue("~/projects/wt/src/x.ts", homeCtx);
    expect(result).toBe("src/x.ts");
  });

  test("~ value that does not match any root keeps ~ spelling", () => {
    // Home is /Users/munawarshah but worktree/cwd are elsewhere. The home
    // fallback returns the same `~/...` string; the formatter then sees
    // "no field change" and emits no displayArgs at the tool level.
    const result = formatWholePathValue("~/Documents/notes.md", {
      worktreePath: "/somewhere/else",
      cwd: "/somewhere/else/deep",
      homeDir: HOME,
    });
    expect(result).toBe("~/Documents/notes.md");
  });

  test("~user/... is not expanded", () => {
    expect(formatWholePathValue("~someone/x", ctx)).toBeUndefined();
  });

  test("value equal to worktree root renders as '.'", () => {
    expect(formatWholePathValue(WORKTREE, ctx)).toBe(".");
  });

  test("value equal to cwd (when no worktree applies) renders as '.'", () => {
    const cwdOnly: ToolDisplayContext = { cwd: CWD, worktreePath: null, homeDir: HOME };
    expect(formatWholePathValue(CWD, cwdOnly)).toBe(".");
  });

  test("path-boundary matching does not collapse foobar under foo", () => {
    const c: ToolDisplayContext = {
      worktreePath: "/repo/foo",
      cwd: null,
      homeDir: HOME,
    };
    expect(formatWholePathValue("/repo/foobar/x.ts", c)).toBeUndefined();
    expect(formatWholePathValue("/repo/foo/x.ts", c)).toBe("x.ts");
  });

  test("trailing slash on worktree root is normalized", () => {
    const c: ToolDisplayContext = {
      worktreePath: `${WORKTREE}/`,
      cwd: CWD,
      homeDir: HOME,
    };
    expect(formatWholePathValue(`${WORKTREE}/src/x.ts`, c)).toBe("src/x.ts");
  });
});

describe("formatBashCommand", () => {
  test("rewrites absolute paths against cwd, not worktree", () => {
    const out = formatBashCommand(`ls ${CWD}/streams`, ctx);
    expect(out).toBe("ls streams");
  });

  test("falls back to ~/... for paths under home but outside cwd", () => {
    const out = formatBashCommand(`cat ${HOME}/Documents/notes.md`, ctx);
    expect(out).toBe("cat ~/Documents/notes.md");
  });

  test("leaves non-path tokens alone", () => {
    expect(formatBashCommand("echo hello world", ctx)).toBeUndefined();
  });

  test("does not use worktree root for bash command text", () => {
    // A path that lives under worktree but NOT under cwd must stay absolute
    // (we only consider cwd + home for bash).
    const outsideCwdInsideWt = `${WORKTREE}/docs/relative-tool-paths/FEATURE.md`;
    const out = formatBashCommand(`cat ${outsideCwdInsideWt}`, ctx);
    expect(out).toBeUndefined();
  });

  test("rewrites multiple matching tokens", () => {
    const out = formatBashCommand(`cp ${CWD}/a.ts ${CWD}/b.ts`, ctx);
    expect(out).toBe("cp a.ts b.ts");
  });
});

describe("createToolPathFormatter.displayArgsForTool", () => {
  const formatter = createToolPathFormatter(ctx);

  test("returns undefined when no field changes", () => {
    expect(formatter.displayArgsForTool("read", { path: "relative/x.ts" })).toBeUndefined();
  });

  test("rewrites read.path", () => {
    const out = formatter.displayArgsForTool("read", {
      path: `${WORKTREE}/src/streams/pi-subscribe.ts`,
    });
    expect(out).toEqual({ path: "src/streams/pi-subscribe.ts" });
  });

  test("rewrites edit.file_path and edit.filePath aliases", () => {
    expect(
      formatter.displayArgsForTool("edit", { file_path: `${WORKTREE}/src/a.ts`, old: "x" }),
    ).toEqual({ file_path: "src/a.ts", old: "x" });
    expect(formatter.displayArgsForTool("edit", { filePath: `${WORKTREE}/b.ts` })).toEqual({
      filePath: "b.ts",
    });
  });

  test("bash uses cwd, not worktree", () => {
    const out = formatter.displayArgsForTool("bash", {
      command: `cat ${CWD}/streams/x.ts`,
    });
    expect(out).toEqual({ command: "cat streams/x.ts" });
  });

  test("glob.pattern is rewritten only when absolute", () => {
    expect(formatter.displayArgsForTool("glob", { pattern: `${WORKTREE}/**/*.ts` })).toEqual({
      pattern: "**/*.ts",
    });
    expect(formatter.displayArgsForTool("glob", { pattern: "**/*.ts" })).toBeUndefined();
  });

  test("unknown tool returns undefined", () => {
    expect(
      formatter.displayArgsForTool("custom_tool", { path: `${WORKTREE}/a.ts` }),
    ).toBeUndefined();
  });

  test("non-object args returns undefined", () => {
    expect(formatter.displayArgsForTool("read", "string-args")).toBeUndefined();
    expect(formatter.displayArgsForTool("read", null)).toBeUndefined();
  });
});

describe("enrichTimelineToolDisplays", () => {
  const formatter = createToolPathFormatter(ctx);

  test("stamps displayArgs on matching tool start items", () => {
    const items: ChatTimelineItem[] = [
      {
        id: "t1",
        kind: "tool",
        tool: "read",
        phase: "start",
        toolUseId: "u1",
        args: { path: `${WORKTREE}/src/x.ts` },
        createdAt: "2026-05-25T00:00:00.000Z",
      },
    ];
    const out = enrichTimelineToolDisplays(items, formatter);
    expect(out).not.toBe(items);
    expect(out[0]?.kind).toBe("tool");
    expect((out[0] as { displayArgs?: unknown }).displayArgs).toEqual({ path: "src/x.ts" });
    // Canonical args unchanged.
    expect((out[0] as { args?: unknown }).args).toEqual({ path: `${WORKTREE}/src/x.ts` });
  });

  test("returns the same reference when nothing changes", () => {
    const items: ChatTimelineItem[] = [
      {
        id: "t1",
        kind: "tool",
        tool: "read",
        phase: "start",
        toolUseId: "u1",
        args: { path: "relative/x.ts" },
        createdAt: "2026-05-25T00:00:00.000Z",
      },
    ];
    const out = enrichTimelineToolDisplays(items, formatter);
    expect(out).toBe(items);
  });

  test("skips items that already carry displayArgs", () => {
    const items: ChatTimelineItem[] = [
      {
        id: "t1",
        kind: "tool",
        tool: "read",
        phase: "start",
        toolUseId: "u1",
        args: { path: `${WORKTREE}/src/x.ts` },
        displayArgs: { path: "src/x.ts" },
        createdAt: "2026-05-25T00:00:00.000Z",
      },
    ];
    const out = enrichTimelineToolDisplays(items, formatter);
    expect(out).toBe(items);
  });

  test("skips tool end items", () => {
    const items: ChatTimelineItem[] = [
      {
        id: "t1",
        kind: "tool",
        tool: "read",
        phase: "end",
        toolUseId: "u1",
        args: { path: `${WORKTREE}/src/x.ts` },
        createdAt: "2026-05-25T00:00:00.000Z",
      },
    ];
    const out = enrichTimelineToolDisplays(items, formatter);
    expect(out).toBe(items);
  });
});

/* ── Cache tests using a fake BlackboardDatabase ─────────────── */

import type { BlackboardDatabase } from "../blackboard/db.ts";
import { createToolDisplayContextCache } from "./tool-display.ts";

type Row = { cwd: string | null; worktree_path: string | null };

function fakeBlackboard(rows: Map<string, Row>): {
  db: BlackboardDatabase;
  queryCount: () => number;
} {
  let queries = 0;
  const db = {
    prepare: (_sql: string) => ({
      get: (piSessionId: string) => {
        queries += 1;
        return rows.get(piSessionId);
      },
    }),
  } as unknown as BlackboardDatabase;
  return { db, queryCount: () => queries };
}

describe("ToolDisplayContextCache", () => {
  test("first formatter build reads DB; subsequent calls reuse it", () => {
    const rows = new Map<string, Row>([["pi-session-test", { cwd: CWD, worktree_path: WORKTREE }]]);
    const { db, queryCount } = fakeBlackboard(rows);
    const cache = createToolDisplayContextCache(db);

    cache.formatterForPiSession("pi-session-test");
    cache.formatterForPiSession("pi-session-test");
    cache.displayArgsForTool("pi-session-test", "read", { path: `${WORKTREE}/a.ts` });

    expect(queryCount()).toBe(1);
  });

  test("invalidate causes next access to re-read updated worktree_path", () => {
    const rows = new Map<string, Row>([["pi-session-test", { cwd: CWD, worktree_path: null }]]);
    const { db } = fakeBlackboard(rows);
    const cache = createToolDisplayContextCache(db);

    // First access — no worktree, cwd-relative only.
    const out1 = cache.displayArgsForTool("pi-session-test", "read", {
      path: `${WORKTREE}/src/x.ts`,
    });
    expect(out1).toEqual({ path: "x.ts" });

    // Update underlying data and invalidate. Next access rebuilds.
    rows.set("pi-session-test", { cwd: CWD, worktree_path: WORKTREE });
    cache.invalidatePiSession("pi-session-test");

    const out2 = cache.displayArgsForTool("pi-session-test", "read", {
      path: `${WORKTREE}/src/x.ts`,
    });
    expect(out2).toEqual({ path: "src/x.ts" });
  });

  test("deletePiSession behaves like invalidate for next access", () => {
    const rows = new Map<string, Row>([["pi-session-test", { cwd: CWD, worktree_path: WORKTREE }]]);
    const { db, queryCount } = fakeBlackboard(rows);
    const cache = createToolDisplayContextCache(db);
    cache.formatterForPiSession("pi-session-test");
    expect(queryCount()).toBe(1);
    cache.deletePiSession("pi-session-test");
    cache.formatterForPiSession("pi-session-test");
    expect(queryCount()).toBe(2);
  });
});
