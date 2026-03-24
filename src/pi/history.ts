import fs, { createReadStream } from "node:fs";
import readline from "node:readline";
import type {
  PiHistoryItem,
  PiHistoryMessageItem,
  PiHistoryResponse,
} from "../contracts/index.ts";

type PiHistoryMode = "agent" | "input";

/** Resolves an agent-generated message ID to a server UUID. Returns null if unmapped. */
export type IdResolver = (agentId: string) => string | null;

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
    const joined = value
      .map((item) => firstText(item))
      .filter((item): item is string => Boolean(item))
      .join("\n");
    return joined.trim() ? joined : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return [record.text, record.message, record.content, record.summary, record.error]
    .map((item) => firstText(item))
    .find((item): item is string => Boolean(item));
}

/** Extract a non-empty string field from a record. */
function extractStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Extract a stable identifier from a message record.
 * For assistant messages, prefer `responseId` (Anthropic API identifier, e.g. `msg_01VM...`).
 * Returns undefined for non-assistant roles or when no responseId is present.
 */
function extractStableId(record: Record<string, unknown>): string | undefined {
  if (record.role === "assistant") {
    return extractStringField(record, "responseId");
  }
  return undefined;
}

/** Resolve an agent ID to a server UUID via the resolver, falling back to the agent ID. */
function resolveId(agentId: string, resolver?: IdResolver): string {
  if (!resolver) return agentId;
  return resolver(agentId) ?? agentId;
}

function pushMessage(
  items: PiHistoryItem[],
  resolvedId: string,
  role: "user" | "assistant" | "system",
  content: string,
  createdAt: string,
  subIndex?: number,
  blocks?: PiHistoryMessageBlock[],
): void {
  let normalized = content.trim();
  const normalizedBlocks = blocks?.filter((block) =>
    block.type === "text" ? block.text.trim() : block.thinking.trim(),
  );
  if (!normalized && (!normalizedBlocks || normalizedBlocks.length === 0)) return;

  // For multi-message splits, append sub-index. Single messages use bare ID.
  const itemId = subIndex !== undefined ? `${resolvedId}:${subIndex}` : resolvedId;

  const item: PiHistoryMessageItem = {
    id: itemId,
    kind: "message",
    role,
    content: normalized,
    createdAt,
  };
  if (normalizedBlocks && normalizedBlocks.length > 0) {
    item.blocks = normalizedBlocks;
  }
  items.push(item);
}

function parseMessageContent(
  items: PiHistoryItem[],
  resolvedId: string,
  role: "user" | "assistant" | "system",
  createdAt: string,
  content: unknown,
): void {
  if (!Array.isArray(content)) {
    const text = firstText(content);
    if (text) pushMessage(items, resolvedId, role, text, createdAt);
    return;
  }

  const messageBlocks: PiHistoryMessageBlock[] = [];
  let textBuffer = "";
  let toolIndex = 0;
  let messageIndex = 0;
  let needsSubIndex = false;

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
    // Use sub-index only when splitting a single agent message into multiple display items
    pushMessage(
      items,
      resolvedId,
      role,
      contentText,
      createdAt,
      needsSubIndex ? messageIndex : undefined,
      [...messageBlocks],
    );
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
      needsSubIndex = true; // Multiple display items from one agent message
      flushMessage();

      // Deterministic tool ID: ${resolvedId}:tool:${toolCallId}:start
      const toolCallId = typeof record.id === "string" ? record.id : undefined;
      const toolItemId = toolCallId
        ? `${resolvedId}:tool:${toolCallId}:start`
        : `${resolvedId}:tool:${toolIndex}:start`;

      items.push({
        id: toolItemId,
        kind: "tool",
        tool: typeof record.name === "string" && record.name.trim() ? record.name : "unknown_tool",
        phase: "start",
        toolUseId: toolCallId,
        args: record.arguments,
        createdAt,
      });
      toolIndex += 1;
    }
  }

  flushMessage();
}

function parseMessageRecord(
  messageRecord: Record<string, unknown>,
  createdAt: string,
  resolvedId: string,
  items: PiHistoryItem[],
): void {
  const role = messageRecord.role;

  if (role === "user" || role === "assistant" || role === "system") {
    parseMessageContent(items, resolvedId, role, createdAt, messageRecord.content);
    return;
  }

  if (role === "toolResult") {
    const resultText = firstText(messageRecord.content);

    // Deterministic tool end ID: ${resolvedId}:tool:${toolCallId}:end
    const toolCallId =
      typeof messageRecord.toolCallId === "string" ? messageRecord.toolCallId : undefined;
    const toolItemId = toolCallId
      ? `${resolvedId}:tool:${toolCallId}:end`
      : `${resolvedId}:tool-end`;

    items.push({
      id: toolItemId,
      kind: "tool",
      tool:
        typeof messageRecord.toolName === "string" && messageRecord.toolName.trim()
          ? messageRecord.toolName
          : "unknown_tool",
      phase: "end",
      toolUseId: toolCallId,
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
    const item = items[i]!;
    const isAssistantMsg = item.kind === "message" && item.role === "assistant";
    const isUserMsg = item.kind === "message" && item.role === "user";

    if (isAssistantMsg) {
      lastAssistantIdx = i;
      continue; // defer — only emit the last one per turn
    }

    if (isUserMsg && lastAssistantIdx >= 0) {
      const kept = { ...items[lastAssistantIdx]!, source: "pi_outbound" } as PiHistoryItem;
      result.push(kept);
      lastAssistantIdx = -1;
    }

    result.push(item);
  }

  // Flush trailing assistant message (last turn with no following user message)
  if (lastAssistantIdx >= 0) {
    const kept = { ...items[lastAssistantIdx]!, source: "pi_outbound" } as PiHistoryItem;
    result.push(kept);
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
    .filter(
      (item) => item.kind === "message" && (item.role === "user" || item.role === "assistant"),
    )
    .map(stripThinkingFromMessage);
}

function shapeHistoryItems(items: PiHistoryItem[], mode: PiHistoryMode): PiHistoryItem[] {
  return mode === "input" ? keepOnlySurfaced(items) : items;
}

function parseHistoryLine(
  line: string,
  lineNumber: number,
  items: PiHistoryItem[],
  resolver?: IdResolver,
): void {
  const parsed = JSON.parse(line) as Record<string, unknown>;
  if (parsed.type !== "message") return;

  const messageRecord = asRecord(parsed.message);
  const createdAt = isoTimestamp(messageRecord.timestamp, parsed.timestamp);
  // For assistant messages, prefer responseId (Anthropic API identifier) as the stable ID.
  // Falls back to the JSONL entry wrapper id, then positional.
  const rawId = extractStableId(messageRecord) ?? extractStringField(parsed, "id") ?? `line-${lineNumber}`;
  const resolvedId = resolveId(rawId, resolver);
  parseMessageRecord(messageRecord, createdAt, resolvedId, items);
}

export function readPiHistoryFromMessages(
  sessionId: string,
  sessionFile: string | null,
  messages: Array<unknown>,
  mode: PiHistoryMode = "agent",
  resolver?: IdResolver,
): PiHistoryResponse {
  const items: PiHistoryItem[] = [];

  messages.forEach((message, index) => {
    const record = asRecord(message);
    const createdAt = isoTimestamp(record.timestamp);
    const rawId = extractStableId(record) ?? extractStringField(record, "id") ?? `memory-${index}`;
    const resolvedId = resolveId(rawId, resolver);
    parseMessageRecord(record, createdAt, resolvedId, items);
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
  resolver?: IdResolver,
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
        parseHistoryLine(line, lineNumber, items, resolver);
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
