import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { readStreamsHistoryFromSession } from "./history.ts";

const timestamp = "2026-07-13T19:00:00.000Z";

function message(id: string, parentId: string | null, content: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: { role: "user", content, timestamp: Date.parse(timestamp) },
  } as SessionEntry;
}

test("renders the compaction boundary immediately before the retained tail", () => {
  const branch = [
    message("old-1", null, "old one"),
    message("old-2", "old-1", "old two"),
    message("kept", "old-2", "retained"),
    message("tail", "kept", "retained tail"),
    {
      type: "compaction",
      id: "compact",
      parentId: "tail",
      timestamp,
      summary: "older context summary",
      firstKeptEntryId: "kept",
      tokensBefore: 51_342,
    },
    message("new", "compact", "after compaction"),
  ] as SessionEntry[];
  const session = {
    getSessionFile: () => null,
    getBranch: () => branch,
  } as unknown as SessionManager;

  const { items } = readStreamsHistoryFromSession("session", session);
  const messages = items.filter((item) => item.kind === "message");

  assert.deepEqual(
    messages.map((item) => item.content),
    [
      "old one",
      "old two",
      "older context summary",
      "retained",
      "retained tail",
      "after compaction",
    ],
  );
  assert.equal(messages[2]?.compaction, true);
});
