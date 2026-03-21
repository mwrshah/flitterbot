import fs from "node:fs";
import { createReadStream } from "node:fs";
import readline from "node:readline";
import type { PiHistoryItem, PiHistoryMessageItem, PiHistoryResponse } from "../../contracts/index.ts";
import { extractSourcePrefix } from "./source-prefix.ts";

type PiHistoryMode = "agent" | "input";

type PiHistoryMessageBlock = NonNullable<PiHistoryMessageItem["blocks"]>[number];

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isoTimestamp(...candidates: unknown[]): string {
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  }
  return new Date().toISOString();
}

function firstText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value)) {
    const joined = value.map((item) => firstText(item)).filter((item): item is string => Boolean(item)).join("\n");
    return joined.trim() ? joined : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return [record.text, record.message, record.content, record.summary, record.error]
    .map((item) => firstText(item))
    .find((item): item is string => Boolean(item));
}


function pushMessage(
  items: PiHistoryItem[],
  id: string,
  role: "user" | "assistant" | "system",
  content: string,
  createdAt: string,
  suffix = "message",
  blocks?: PiHistoryMessageBlock[],
): void {
  let normalized = content.trim();
  const normalizedBlocks = blocks?.filter((block) =>
    block.type === "text" ? block.text.trim() : block.thinking.trim(),
  );
  if (!normalized && (!normalizedBlocks || normalizedBlocks.length === 0)) return;

  // Extract source from <context source="..." /> tag on user messages
  let source: string | undefined;
  if (role === "user") {
    const extracted = extractSourcePrefix(normalized);
    source = extracted.source;
    normalized = extracted.cleanContent.trim();
  }

  const item: PiHistoryMessageItem = {
    id: `${id}:${suffix}`,
    kind: "message",
    role,
    content: normalized,
    createdAt,
  };
  if (source) item.source = source;
  if (normalizedBlocks && normalizedBlocks.length > 0) {
    item.blocks = normalizedBlocks;
  }
  items.push(item);
}

function parseMessageContent(
  items: PiHistoryItem[],
  messageId: string,
  role: "user" | "assistant" | "system",
  createdAt: string,
  content: unknown,
): void {
  if (!Array.isArray(content)) {
    const text = firstText(content);
    if (text) pushMessage(items, messageId, role, text, createdAt);
    return;
  }

  const messageBlocks: PiHistoryMessageBlock[] = [];
  let textBuffer = "";
  let toolIndex = 0;
  let messageIndex = 0;

  const flushTextBlock = () => {
    if (!textBuffer.trim()) return;
    messageBlocks.push({ type: "text", text: textBuffer });
    textBuffer = "";
  };

  const flushMessage = () => {
    flushTextBlock();
    if (messageBlocks.length === 0) return;
    const contentText = messageBlocks
      .map((block) => (block.type === "text" ? block.text : block.thinking))
      .join("\n\n");
    pushMessage(items, messageId, role, contentText, createdAt, `message-${messageIndex}`, [...messageBlocks]);
    messageBlocks.length = 0;
    messageIndex += 1;
  };

  for (const block of content) {
    const record = asRecord(block);
    const type = typeof record.type === "string" ? record.type : undefined;

    if (type === "text" && typeof record.text === "string") {
      textBuffer += record.text;
      continue;
    }

    if (type === "thinking" && role === "assistant" && typeof record.thinking === "string") {
      flushTextBlock();
      if (record.thinking.trim()) {
        messageBlocks.push({ type: "thinking", thinking: record.thinking });
      }
      continue;
    }

    if (type === "toolCall") {
      flushMessage();
      items.push({
        id: `${messageId}:tool-start-${toolIndex}`,
        kind: "tool",
        tool: typeof record.name === "string" && record.name.trim() ? record.name : "unknown_tool",
        phase: "start",
        toolUseId: typeof record.id === "string" ? record.id : undefined,
        args: record.arguments,
        createdAt,
      });
      toolIndex += 1;
      continue;
    }
  }

  flushMessage();
}

function parseMessageRecord(messageRecord: Record<string, unknown>, createdAt: string, messageId: string, items: PiHistoryItem[]): void {
  const role = messageRecord.role;

  if (role === "user" || role === "assistant" || role === "system") {
    parseMessageContent(items, messageId, role, createdAt, messageRecord.content);
    return;
  }

  if (role === "toolResult") {
    const resultText = firstText(messageRecord.content);
    items.push({
      id: `${messageId}:tool-end`,
      kind: "tool",
      tool:
        typeof messageRecord.toolName === "string" && messageRecord.toolName.trim()
          ? messageRecord.toolName
          : "unknown_tool",
      phase: "end",
      toolUseId: typeof messageRecord.toolCallId === "string" ? messageRecord.toolCallId : undefined,
      result: messageRecord.details ?? resultText,
      isError: Boolean(messageRecord.isError),
      createdAt,
    });
  }
}

function keepOnlySurfacedAssistant(items: PiHistoryItem[]): PiHistoryItem[] {
  const result: PiHistoryItem[] = [];
  let lastAssistantIdx = -1;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const isAssistantMsg = item.kind === "message" && item.role === "assistant";
    const isUserMsg = item.kind === "message" && item.role === "user";

    if (isAssistantMsg) {
      lastAssistantIdx = i;
      continue; // defer — only emit the last one per turn
    }

    if (isUserMsg && lastAssistantIdx >= 0) {
      result.push(items[lastAssistantIdx]);
      lastAssistantIdx = -1;
    }

    result.push(item);
  }

  // Flush trailing assistant message (last turn with no following user message)
  if (lastAssistantIdx >= 0) {
    result.push(items[lastAssistantIdx]);
  }

  return result;
}

/**
 * Strip everything except user messages and the final surfaced assistant message per turn.
 * This mirrors the WhatsApp / InputSurface live path: no tools, no system messages.
 */
function stripThinkingFromMessage(item: PiHistoryItem): PiHistoryItem {
  if (item.kind !== "message" || item.role !== "assistant") return item;
  const msg = item as PiHistoryMessageItem;
  if (!msg.blocks?.length) return item;
  const textBlocks = msg.blocks.filter((b) => b.type === "text");
  if (textBlocks.length === 0) return item;
  const textOnly = textBlocks.map((b) => (b as { type: "text"; text: string }).text).join("\n\n");
  return { ...msg, content: textOnly, blocks: textBlocks };
}

function keepOnlySurfaced(items: PiHistoryItem[]): PiHistoryItem[] {
  return keepOnlySurfacedAssistant(items)
    .filter((item) => item.kind === "message" && (item.role === "user" || item.role === "assistant"))
    .map(stripThinkingFromMessage);
}

function shapeHistoryItems(items: PiHistoryItem[], mode: PiHistoryMode): PiHistoryItem[] {
  return mode === "input" ? keepOnlySurfaced(items) : items;
}

function parseHistoryLine(line: string, lineNumber: number, items: PiHistoryItem[]): void {
  const parsed = JSON.parse(line) as Record<string, unknown>;
  if (parsed.type !== "message") return;

  const messageRecord = asRecord(parsed.message);
  const createdAt = isoTimestamp(messageRecord.timestamp, parsed.timestamp);
  const messageId = typeof parsed.id === "string" && parsed.id.trim() ? parsed.id : `line-${lineNumber}`;
  parseMessageRecord(messageRecord, createdAt, messageId, items);
}

export function readPiHistoryFromMessages(
  sessionId: string,
  sessionFile: string | null,
  messages: Array<unknown>,
  mode: PiHistoryMode = "agent",
): PiHistoryResponse {
  const items: PiHistoryItem[] = [];

  messages.forEach((message, index) => {
    const record = asRecord(message);
    const createdAt = isoTimestamp(record.timestamp);
    const messageId = typeof record.id === "string" && record.id.trim() ? record.id : `memory-${index}`;
    parseMessageRecord(record, createdAt, messageId, items);
  });

  return {
    sessionId,
    sessionFile,
    items: shapeHistoryItems(items, mode),
  };
}

export async function readPiHistory(
  sessionId: string,
  sessionFile: string,
  mode: PiHistoryMode = "agent",
): Promise<PiHistoryResponse> {
  if (!fs.existsSync(sessionFile)) {
    return {
      sessionId,
      sessionFile,
      items: [],
    };
  }

  const stream = createReadStream(sessionFile, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const items: PiHistoryItem[] = [];
  let lineNumber = 0;

  try {
    for await (const rawLine of lines) {
      lineNumber += 1;
      const line = rawLine.trim();
      if (!line) continue;
      try {
        parseHistoryLine(line, lineNumber, items);
      } catch {
        // Ignore malformed lines and continue reading the session.
      }
    }
  } finally {
    lines.close();
    stream.close();
  }

  return {
    sessionId,
    sessionFile,
    items: shapeHistoryItems(items, mode),
  };
}
