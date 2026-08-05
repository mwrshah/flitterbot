import type {
  ChatTimelineItem,
  ChatTimelineMessage,
  ChatTimelineMessageBlock,
  ChatTimelineTool,
} from "./types";

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
  | Exclude<ChatTimelineMessageBlock, { type: "tool" }>
  | { type: "tool"; tool: ConversationToolBlock };

export function buildConversationContentParts(
  message: ChatTimelineMessage | undefined,
  tools: ConversationToolBlock[],
): ConversationContentPart[] {
  const blocks =
    message?.blocks ?? (message ? [{ type: "text" as const, text: message.content }] : []);
  const toolsById = new Map(
    tools.flatMap((tool) => (tool.start.toolUseId ? [[tool.start.toolUseId, tool] as const] : [])),
  );
  const renderedTools = new Set<ConversationToolBlock>();
  const parts: ConversationContentPart[] = [];

  for (const block of blocks) {
    if (block.type !== "tool") {
      parts.push(block);
      continue;
    }
    const tool = toolsById.get(block.toolUseId);
    if (tool && !renderedTools.has(tool)) {
      renderedTools.add(tool);
      parts.push({ type: "tool", tool });
    }
  }
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
    if (item.kind === "tool" && item.phase === "end" && item.toolUseId) {
      ends.set(item.toolUseId, item);
    }
  }

  const rows: ConversationRow[] = [];
  const activeToolBlocks = new Map<string, ConversationToolBlock>();
  let attachTo: ConversationRow | undefined;

  for (const item of items) {
    if (item.kind === "divider") {
      attachTo = undefined;
      continue;
    }
    if (item.kind === "message") {
      attachTo = undefined;
      if (item.role === "system") continue;
      const row: ConversationRow = { key: item.id, message: item, tools: [] };
      rows.push(row);
      if (item.role === "assistant") attachTo = row;
      continue;
    }
    if (item.phase !== "start" && item.phase !== "update") continue;

    const existing = item.toolUseId ? activeToolBlocks.get(item.toolUseId) : undefined;
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
      end: item.toolUseId ? ends.get(item.toolUseId) : undefined,
    };
    attachTo.tools.push(block);
    if (item.toolUseId) activeToolBlocks.set(item.toolUseId, block);
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
