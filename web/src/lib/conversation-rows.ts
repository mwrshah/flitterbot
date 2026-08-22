import type { ChatTimelineItem, ChatTimelineMessage, ChatTimelineTool } from "./types";

export type ConversationToolBlock = {
  start: ChatTimelineTool;
  end?: ChatTimelineTool;
};

export type ConversationRow = {
  key: string;
  message?: ChatTimelineMessage;
  tools: ConversationToolBlock[];
  copyText?: string;
  isCurrentTurn?: boolean;
};

export type ConversationContentPart =
  | { type: "text"; text: string; streaming: boolean }
  | { type: "thinking"; thinking: string; streaming: boolean }
  | { type: "tool"; tool: ConversationToolBlock };

export function buildConversationContentParts(
  message: ChatTimelineMessage | undefined,
  tools: ConversationToolBlock[],
  activeContentIndexes?: ReadonlySet<number>,
): ConversationContentPart[] {
  const blocks =
    message?.blocks ?? (message ? [{ type: "text" as const, text: message.content }] : []);
  const toolsById = new Map(tools.map((tool) => [tool.start.toolUseId, tool]));
  const renderedTools = new Set<ConversationToolBlock>();
  const parts: ConversationContentPart[] = [];
  let textRun: Extract<ConversationContentPart, { type: "text" }> | undefined;
  let thinkingRun: Extract<ConversationContentPart, { type: "thinking" }> | undefined;

  const flushText = () => {
    if (textRun) parts.push(textRun);
    textRun = undefined;
  };
  const flushThinking = () => {
    if (thinkingRun) parts.push(thinkingRun);
    thinkingRun = undefined;
  };

  for (const [contentIndex, block] of blocks.entries()) {
    if (block.type === "thinking") {
      if (!block.thinking.trim()) continue;
      flushText();
      if (thinkingRun) {
        thinkingRun.thinking += `\n\n${block.thinking}`;
        thinkingRun.streaming ||= activeContentIndexes?.has(contentIndex) ?? false;
      } else {
        thinkingRun = {
          type: "thinking",
          thinking: block.thinking,
          streaming: activeContentIndexes?.has(contentIndex) ?? false,
        };
      }
      continue;
    }

    if (block.type === "text") {
      if (!block.text.trim()) continue;
      flushThinking();
      if (textRun) {
        textRun.text += block.text;
        textRun.streaming ||= activeContentIndexes?.has(contentIndex) ?? false;
      } else {
        textRun = {
          type: "text",
          text: block.text,
          streaming: activeContentIndexes?.has(contentIndex) ?? false,
        };
      }
      continue;
    }

    flushText();
    flushThinking();
    const tool = toolsById.get(block.toolUseId);
    if (tool && !renderedTools.has(tool)) {
      renderedTools.add(tool);
      parts.push({ type: "tool", tool });
    }
  }

  flushText();
  flushThinking();
  for (const tool of tools) {
    if (!renderedTools.has(tool)) parts.push({ type: "tool", tool });
  }
  return parts;
}

function assistantText(message: ChatTimelineMessage): string[] {
  const blocks = message.blocks ?? [{ type: "text" as const, text: message.content }];
  return blocks.flatMap((block) =>
    block.type === "text" && block.text.trim() ? [block.text] : [],
  );
}

export function buildConversationRows(items: ChatTimelineItem[]): ConversationRow[] {
  const ends = new Map<string, ChatTimelineTool>();
  for (const item of items) {
    if (item.kind === "tool" && item.phase === "end") ends.set(item.toolUseId, item);
  }

  const rows: ConversationRow[] = [];
  const activeToolBlocks = new Map<string, ConversationToolBlock>();
  let attachTo: ConversationRow | undefined;

  for (const item of items) {
    if (item.kind === "message") {
      attachTo = undefined;
      if (item.role === "system") continue;
      const row: ConversationRow = { key: item.id, message: item, tools: [] };
      rows.push(row);
      if (item.role === "assistant") attachTo = row;
      continue;
    }
    if (item.phase !== "start" && item.phase !== "update") continue;

    const existing = activeToolBlocks.get(item.toolUseId);
    if (existing) {
      existing.start = {
        ...existing.start,
        ...item,
        id: existing.start.id,
        args: item.args ?? existing.start.args,
        displayArgs: item.displayArgs ?? existing.start.displayArgs,
      };
      continue;
    }

    if (!attachTo) {
      attachTo = { key: item.id, tools: [] };
      rows.push(attachTo);
    }
    const block = {
      start: item,
      end: ends.get(item.toolUseId),
    };
    attachTo.tools.push(block);
    activeToolBlocks.set(item.toolUseId, block);
  }

  const keyCounts = new Map<string, number>();
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    if (!row) continue;
    const base = row.key;
    const duplicate = keyCounts.get(base) ?? 0;
    keyCounts.set(base, duplicate + 1);
    row.key = duplicate === 0 ? `row:${base}` : `row:${base}:duplicate-${duplicate}`;
  }

  let turnText: string[] = [];
  let turnAssistants: ConversationRow[] = [];
  const finishTurn = (isCurrentTurn = false) => {
    const last = turnAssistants.at(-1);
    if (last && turnText.length) {
      last.copyText = turnText.join("\n");
      last.isCurrentTurn = isCurrentTurn;
    }
    turnText = [];
    turnAssistants = [];
  };

  for (const row of rows) {
    if (row.message?.role === "user") {
      finishTurn();
    } else {
      turnAssistants.push(row);
      if (row.message) turnText.push(...assistantText(row.message));
    }
  }
  finishTurn(true);
  return rows;
}
