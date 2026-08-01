import assert from "node:assert/strict";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  STREAMS_HISTORY_DEFAULT_VISIBLE_ROW_LIMIT,
  STREAMS_HISTORY_MAX_VISIBLE_ROW_LIMIT,
} from "../src/contracts/control-surface-api.ts";
import type { ChatTimelineItem, StreamsHistoryResponse } from "../src/contracts/index.ts";
import { handleBrowserStreamsHistoryRoute } from "../src/routes/browser-streams.ts";
import type { ControlSurfaceRuntime } from "../src/runtime.ts";

const PI_SESSION_ID = "pi-session-history-pagination";

function writeSessionFileWithToolWrappedTurns(directory: string, turns: number): string {
  const file = path.join(directory, "session.jsonl");
  const lines: string[] = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: PI_SESSION_ID,
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: directory,
    }),
  ];

  let parentId: string | null = null;
  let clock = 0;
  const nextTimestamp = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString();

  const append = (id: string, message: unknown) => {
    lines.push(
      JSON.stringify({ type: "message", id, parentId, timestamp: nextTimestamp(), message }),
    );
    parentId = id;
  };

  for (let turn = 0; turn < turns; turn++) {
    append(`user-${turn}`, {
      role: "user",
      content: [{ type: "text", text: `user message ${turn}` }],
    });
    append(`assistant-tool-${turn}`, {
      role: "assistant",
      content: [
        { type: "text", text: `thinking out loud ${turn}` },
        { type: "toolCall", id: `call-${turn}`, name: "Read", arguments: { file: `f${turn}.ts` } },
      ],
    });
    append(`toolresult-${turn}`, {
      role: "toolResult",
      toolCallId: `call-${turn}`,
      toolName: "Read",
      content: [{ type: "text", text: `contents ${turn}` }],
    });
    append(`assistant-${turn}`, {
      role: "assistant",
      content: [{ type: "text", text: `assistant reply ${turn}` }],
    });
  }

  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

type CapturedResponse = { status: number; body: unknown };

function fakeResponse(captured: CapturedResponse): http.ServerResponse {
  return {
    set statusCode(value: number) {
      captured.status = value;
    },
    get statusCode() {
      return captured.status;
    },
    setHeader() {},
    end(payload: string) {
      captured.body = JSON.parse(payload);
    },
  } as unknown as http.ServerResponse;
}

function fakeRuntime(sessionFile: string): ControlSurfaceRuntime {
  return {
    blackboard: {
      prepare() {
        return { get: () => ({ session_file: sessionFile }) };
      },
    },
    sessionManager: {
      getByPiSessionId: () => undefined,
      getDefault: () => undefined,
      toolDisplayCache: {
        formatterForPiSession: () => ({ displayArgsForTool: () => undefined }),
      },
    },
  } as unknown as ControlSurfaceRuntime;
}

async function fetchHistory(
  runtime: ControlSurfaceRuntime,
  query: string,
): Promise<{ status: number; body: StreamsHistoryResponse & { error?: string } }> {
  const captured: CapturedResponse = { status: 200, body: undefined };
  const request = { url: `/api/streams/history?${query}` } as http.IncomingMessage;
  await handleBrowserStreamsHistoryRoute(runtime, request, fakeResponse(captured));
  return {
    status: captured.status,
    body: captured.body as StreamsHistoryResponse & { error?: string },
  };
}

function withSession(
  turns: number,
  run: (runtime: ControlSurfaceRuntime) => Promise<void>,
): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flitterbot-history-page-"));
  const sessionFile = writeSessionFileWithToolWrappedTurns(directory, turns);
  return run(fakeRuntime(sessionFile)).finally(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
}

function isVisibleRow(item: ChatTimelineItem): boolean {
  return item.kind === "message" && (item.role === "user" || item.role === "assistant");
}

function visibleRows(items: ChatTimelineItem[]): ChatTimelineItem[] {
  return items.filter(isVisibleRow);
}

function isChronological(items: ChatTimelineItem[]): boolean {
  for (let i = 1; i < items.length; i++) {
    if (Date.parse(items[i - 1]!.createdAt) > Date.parse(items[i]!.createdAt)) return false;
  }
  return true;
}

test("newest page is bounded by the default visible-row limit", async () => {
  await withSession(40, async (runtime) => {
    const { status, body } = await fetchHistory(runtime, `piSessionId=${PI_SESSION_ID}`);
    assert.equal(status, 200);
    assert.equal(body.appliedVisibleRowLimit, STREAMS_HISTORY_DEFAULT_VISIBLE_ROW_LIMIT);
    assert.equal(visibleRows(body.items).length, STREAMS_HISTORY_DEFAULT_VISIBLE_ROW_LIMIT);
    assert.equal(body.hasOlderRows, true);
    assert.ok(body.olderPageCursor);

    const last = visibleRows(body.items).at(-1);
    assert.equal(last?.kind === "message" && last.content, "assistant reply 39");
  });
});

test("previous cursor returns the page immediately older with no overlap", async () => {
  await withSession(20, async (runtime) => {
    const first = await fetchHistory(runtime, `piSessionId=${PI_SESSION_ID}&limit=10`);
    assert.equal(visibleRows(first.body.items).length, 10);

    const second = await fetchHistory(
      runtime,
      `piSessionId=${PI_SESSION_ID}&limit=10&before=${encodeURIComponent(first.body.olderPageCursor ?? "")}`,
    );
    assert.equal(second.status, 200);
    assert.equal(visibleRows(second.body.items).length, 10);

    const firstIds = new Set(first.body.items.map((item) => item.id));
    for (const item of second.body.items) {
      assert.ok(!firstIds.has(item.id), `overlapping item ${item.id}`);
    }

    const merged = [...second.body.items, ...first.body.items];
    assert.ok(isChronological(merged));
    assert.equal(
      Date.parse(second.body.items.at(-1)!.createdAt) <=
        Date.parse(first.body.items[0]!.createdAt),
      true,
    );
  });
});

test("paging backwards walks the whole history and terminates", async () => {
  await withSession(12, async (runtime) => {
    const collected: ChatTimelineItem[] = [];
    let cursor: string | null | undefined = null;
    let pages = 0;

    do {
      const query = cursor
        ? `piSessionId=${PI_SESSION_ID}&limit=5&before=${encodeURIComponent(cursor)}`
        : `piSessionId=${PI_SESSION_ID}&limit=5`;
      const { body } = await fetchHistory(runtime, query);
      collected.unshift(...body.items);
      cursor = body.olderPageCursor;
      pages++;
      assert.ok(pages < 50, "pagination did not terminate");
    } while (cursor);

    const full = await fetchHistory(runtime, `piSessionId=${PI_SESSION_ID}&limit=200`);
    assert.deepEqual(
      collected.map((item) => item.id),
      full.body.items.map((item) => item.id),
    );
    assert.equal(visibleRows(collected).length, visibleRows(full.body.items).length);
    assert.ok(isChronological(collected));
  });
});

test("page boundaries keep complete visible rows and their attached tool events", async () => {
  await withSession(8, async (runtime) => {
    const { body } = await fetchHistory(runtime, `piSessionId=${PI_SESSION_ID}&limit=4`);
    const items = body.items;

    const firstItemOfPage = items[0]!;
    assert.ok(
      isVisibleRow(firstItemOfPage),
      "page starts on a partial row instead of a complete visible message",
    );

    const toolStarts = items.filter((item) => item.kind === "tool" && item.phase === "start");
    const toolEnds = items.filter((item) => item.kind === "tool" && item.phase === "end");
    assert.ok(toolStarts.length > 0);
    assert.equal(toolStarts.length, toolEnds.length);
    for (const start of toolStarts) {
      assert.ok(
        toolEnds.some(
          (end) =>
            end.kind === "tool" &&
            start.kind === "tool" &&
            end.toolUseId === start.toolUseId,
        ),
        "tool start without its result in the same page",
      );
    }
    assert.ok(isChronological(items));
  });
});

test("limit is validated and clamped", async () => {
  await withSession(6, async (runtime) => {
    const zero = await fetchHistory(runtime, `piSessionId=${PI_SESSION_ID}&limit=0`);
    assert.equal(zero.body.appliedVisibleRowLimit, 1);

    const negative = await fetchHistory(runtime, `piSessionId=${PI_SESSION_ID}&limit=-5`);
    assert.equal(negative.body.appliedVisibleRowLimit, 1);

    const huge = await fetchHistory(runtime, `piSessionId=${PI_SESSION_ID}&limit=99999`);
    assert.equal(huge.body.appliedVisibleRowLimit, STREAMS_HISTORY_MAX_VISIBLE_ROW_LIMIT);

    const garbage = await fetchHistory(runtime, `piSessionId=${PI_SESSION_ID}&limit=abc`);
    assert.equal(garbage.body.appliedVisibleRowLimit, STREAMS_HISTORY_DEFAULT_VISIBLE_ROW_LIMIT);
  });
});

test("invalid cursor is rejected with 400", async () => {
  await withSession(6, async (runtime) => {
    for (const cursor of ["not-base64!!", Buffer.from("{}").toString("base64url")]) {
      const { status, body } = await fetchHistory(
        runtime,
        `piSessionId=${PI_SESSION_ID}&before=${encodeURIComponent(cursor)}`,
      );
      assert.equal(status, 400, `cursor ${cursor} should be rejected`);
      assert.equal(body.error, "Invalid cursor");
    }

    const unknown = Buffer.from(JSON.stringify({ v: 1, id: "nope", i: 999 })).toString("base64url");
    const { status } = await fetchHistory(
      runtime,
      `piSessionId=${PI_SESSION_ID}&before=${encodeURIComponent(unknown)}`,
    );
    assert.equal(status, 400);
  });
});
