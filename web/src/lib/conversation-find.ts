import type { ConversationRow } from "./conversation-rows.ts";
import type { ChatTimelineItem } from "./types.ts";

export type ConversationFindResults = {
  rows: Array<{ rowIndex: number; firstMatchIndex: number; matchCount: number }>;
  matchCount: number;
};

export const EMPTY_CONVERSATION_FIND_RESULTS: ConversationFindResults = {
  rows: [],
  matchCount: 0,
};

export function mergeFindTimeline(
  complete: ChatTimelineItem[] | undefined,
  current: ChatTimelineItem[],
): ChatTimelineItem[] {
  if (!complete) return current;
  const currentById = new Map(current.map((item) => [item.id, item]));
  const completeIds = new Set(complete.map((item) => item.id));
  return [
    ...complete.map((item) => currentById.get(item.id) ?? item),
    ...current.filter((item) => !completeIds.has(item.id)),
  ];
}

function countOccurrences(content: string, query: string): number {
  let count = 0;
  let fromIndex = 0;
  while (fromIndex <= content.length - query.length) {
    const matchIndex = content.indexOf(query, fromIndex);
    if (matchIndex < 0) break;
    count++;
    fromIndex = matchIndex + query.length;
  }
  return count;
}

export function findConversationMatches(
  rows: ConversationRow[],
  rawQuery: string,
): ConversationFindResults {
  const query = rawQuery.toLowerCase();
  if (!query) return EMPTY_CONVERSATION_FIND_RESULTS;

  const matchingRows: ConversationFindResults["rows"] = [];
  let matchCount = 0;
  for (const [rowIndex, row] of rows.entries()) {
    const message = row.message;
    if (!message) continue;
    const segments =
      message.role === "assistant"
        ? (message.blocks ?? [{ type: "text" as const, text: message.content }]).flatMap((block) =>
            block.type === "text" ? [block.text] : [],
          )
        : [message.content];
    const rowMatchCount = segments.reduce(
      (count, segment) => count + countOccurrences(segment.toLowerCase(), query),
      0,
    );
    if (!rowMatchCount) continue;
    matchingRows.push({ rowIndex, firstMatchIndex: matchCount, matchCount: rowMatchCount });
    matchCount += rowMatchCount;
  }
  return { rows: matchingRows, matchCount };
}

export function conversationFindRowAt(
  results: ConversationFindResults,
  matchIndex: number,
): number | undefined {
  return results.rows.find(
    (row) => matchIndex >= row.firstMatchIndex && matchIndex < row.firstMatchIndex + row.matchCount,
  )?.rowIndex;
}

export function moveConversationFindSelection(
  currentIndex: number,
  matchCount: number,
  delta: -1 | 1,
): number {
  if (!matchCount) return 0;
  return (currentIndex + delta + matchCount) % matchCount;
}
