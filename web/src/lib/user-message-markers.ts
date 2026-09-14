import type { ConversationRow } from "./conversation-rows";

type ViewportItem = {
  index: number;
  start: number;
  end: number;
};

export function activeUserMessageIdForViewport(
  rows: ConversationRow[],
  userMessageIndex: string[],
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
    if (message?.role !== "user") continue;
    if (!topmostVisible || item.start < topmostVisible.start) {
      topmostVisible = { id: message.id, start: item.start };
    }
  }

  if (topmostVisible) return topmostVisible.id;
  if (!topmostRow) return undefined;

  for (let index = Math.min(topmostRow.index, rows.length - 1); index >= 0; index--) {
    const message = rows[index]?.message;
    if (message?.role === "user") return message.id;
  }

  for (let index = topmostRow.index + 1; index < rows.length; index++) {
    const message = rows[index]?.message;
    if (message?.role !== "user") continue;
    const nextUserIndex = userMessageIndex.indexOf(message.id);
    return nextUserIndex > 0 ? userMessageIndex[nextUserIndex - 1] : message.id;
  }

  return userMessageIndex.at(-1);
}
