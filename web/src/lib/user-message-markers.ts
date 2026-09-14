import { isUserTimelineMessage } from "../../../src/contracts/timeline.ts";
import type { ConversationRow } from "./conversation-rows";
import type { UserMessageIndexEntry } from "./types";

type ViewportItem = {
  index: number;
  start: number;
  end: number;
};

export function activeUserMessageIdForViewport(
  rows: ConversationRow[],
  userMessageIndex: UserMessageIndexEntry[],
  virtualItems: ViewportItem[],
  viewportStart: number,
  viewportEnd: number,
): string | undefined {
  let topmostVisible: { id: string; start: number } | undefined;
  let topmostRow: { index: number; start: number } | undefined;

  for (const item of virtualItems) {
    if (item.end <= viewportStart || item.start >= viewportEnd) continue;
    if (!topmostRow || item.start < topmostRow.start) {
      topmostRow = { index: item.index, start: item.start };
    }
    const message = rows[item.index]?.message;
    if (!message || !isUserTimelineMessage(message)) continue;
    if (!topmostVisible || item.start < topmostVisible.start) {
      topmostVisible = { id: message.id, start: item.start };
    }
  }

  if (topmostVisible) return topmostVisible.id;
  if (!topmostRow) return undefined;

  for (let index = Math.min(topmostRow.index, rows.length - 1); index >= 0; index--) {
    const message = rows[index]?.message;
    if (message && isUserTimelineMessage(message)) return message.id;
  }

  for (let index = topmostRow.index + 1; index < rows.length; index++) {
    const message = rows[index]?.message;
    if (!message || !isUserTimelineMessage(message)) continue;
    const nextUserIndex = userMessageIndex.findIndex((entry) => entry.id === message.id);
    return nextUserIndex > 0 ? userMessageIndex[nextUserIndex - 1]?.id : message.id;
  }

  return userMessageIndex.at(-1)?.id;
}
