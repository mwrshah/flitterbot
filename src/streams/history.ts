import fs from "node:fs";
import {
  parseSessionEntries,
  type SessionEntry,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  STREAMS_HISTORY_DEFAULT_VISIBLE_ROW_LIMIT,
  STREAMS_HISTORY_MAX_VISIBLE_ROW_LIMIT,
} from "../contracts/control-surface-api.ts";
import type {
  ChatTimelineItem,
  ChatTimelineMessage,
  ChatTimelineMessageBlock,
  ChatTimelineTool,
  ImageAttachment,
  JsonValue,
  TokenUsage,
} from "../contracts/index.ts";
import { conversationMessageId } from "./conversation-identity.ts";

export function parseUsage(value: unknown): TokenUsage | undefined {
  const record = asRecord(value);
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  if (Object.keys(record).length === 0) return undefined;
  const usage: TokenUsage = {
    input: num(record.input),
    output: num(record.output),
    cacheRead: num(record.cacheRead),
    cacheWrite: num(record.cacheWrite),
    totalTokens: num(record.totalTokens),
  };
  if (typeof record.reasoning === "number" && Number.isFinite(record.reasoning)) {
    usage.reasoning = record.reasoning;
  }
  return usage;
}

type StreamsHistoryMode = "agent" | "input";

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

function pushMessage(
  items: ChatTimelineItem[],
  id: string,
  role: "user" | "assistant" | "system",
  content: string,
  createdAt: string,
  blocks?: ChatTimelineMessageBlock[],
  images?: ImageAttachment[],
  usage?: TokenUsage,
  piEntryId?: string,
): void {
  const normalized = content.trim();
  const normalizedBlocks = blocks?.filter((block) => {
    if (block.type === "text") return block.text.trim();
    if (block.type === "thinking") return block.thinking.trim();
    return block.toolUseId.trim();
  });
  if (
    !normalized &&
    (!normalizedBlocks || normalizedBlocks.length === 0) &&
    (!images || images.length === 0)
  )
    return;

  const item: ChatTimelineMessage = {
    id,
    ...(piEntryId ? { piEntryId } : {}),
    kind: "message",
    role,
    content: normalized,
    createdAt,
  };
  if (normalizedBlocks && normalizedBlocks.length > 0) {
    item.blocks = normalizedBlocks;
  }
  if (images && images.length > 0) {
    item.images = images;
  }
  if (usage) {
    item.usage = usage;
  }
  items.push(item);
}

function parseMessageContent(
  items: ChatTimelineItem[],
  messageId: string,
  role: "user" | "assistant" | "system",
  createdAt: string,
  content: unknown,
  usage?: TokenUsage,
  piEntryId?: string,
  fallbackImages?: ImageAttachment[],
): void {
  if (!Array.isArray(content)) {
    pushMessage(
      items,
      messageId,
      role,
      firstText(content) ?? "",
      createdAt,
      undefined,
      fallbackImages,
      usage,
      piEntryId,
    );
    return;
  }

  const messageBlocks: ChatTimelineMessageBlock[] = [];
  const imageAttachments: ImageAttachment[] = [];
  const toolItems: ChatTimelineTool[] = [];
  let textBuffer = "";

  const flushTextBlock = () => {
    const text = textBuffer;
    textBuffer = "";
    if (text.trim()) messageBlocks.push({ type: "text", text });
  };

  for (const block of content) {
    const record = asRecord(block);
    const type = typeof record.type === "string" ? record.type : undefined;

    if (type === "text" && typeof record.text === "string") {
      textBuffer += record.text;
      continue;
    }

    if (
      type === "image" &&
      typeof record.data === "string" &&
      typeof record.mimeType === "string"
    ) {
      imageAttachments.push({ data: record.data, mimeType: record.mimeType });
      continue;
    }

    if (type === "thinking" && role === "assistant" && typeof record.thinking === "string") {
      flushTextBlock();
      if (record.thinking.trim()) {
        messageBlocks.push({ type: "thinking", thinking: record.thinking });
      }
      continue;
    }

    if (
      type === "toolCall" &&
      typeof record.id === "string" &&
      record.id.trim() &&
      typeof record.name === "string" &&
      record.name.trim()
    ) {
      flushTextBlock();
      const toolUseId = record.id;
      messageBlocks.push({ type: "tool", toolUseId });
      toolItems.push({
        id: `tool-${toolUseId}-start`,
        ...(piEntryId ? { piEntryId } : {}),
        kind: "tool",
        tool: record.name,
        phase: "start",
        toolUseId,
        args: record.arguments as JsonValue | undefined,
        createdAt,
      });
    }
  }

  flushTextBlock();
  const contentText = messageBlocks
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n\n");
  pushMessage(
    items,
    messageId,
    role,
    contentText,
    createdAt,
    messageBlocks,
    imageAttachments.length ? imageAttachments : fallbackImages,
    usage,
    piEntryId,
  );
  items.push(...toolItems);
}

export function piMessageToTimelineItems(
  message: unknown,
  {
    messageId,
    createdAt,
    piEntryId,
    fallbackImages,
  }: {
    messageId: string;
    createdAt: string;
    piEntryId?: string;
    fallbackImages?: ImageAttachment[];
  },
): ChatTimelineItem[] {
  const record = asRecord(message);
  const role = record.role;
  if (role === "user" || role === "assistant" || role === "system") {
    const items: ChatTimelineItem[] = [];
    const usage = role === "assistant" ? parseUsage(record.usage) : undefined;
    parseMessageContent(
      items,
      messageId,
      role,
      createdAt,
      record.content,
      usage,
      piEntryId,
      fallbackImages,
    );
    return items;
  }
  if (role !== "toolResult") return [];

  const resultText = firstText(record.content);
  const toolCallId = record.toolCallId;
  const toolName = record.toolName;
  if (
    typeof toolCallId !== "string" ||
    !toolCallId.trim() ||
    typeof toolName !== "string" ||
    !toolName.trim()
  ) {
    return [];
  }

  return [
    {
      id: `tool-${toolCallId}-end`,
      ...(piEntryId ? { piEntryId } : {}),
      kind: "tool",
      tool: toolName,
      phase: "end",
      toolUseId: toolCallId,
      result: (toolName === "bash" ? resultText : (record.details ?? resultText)) as
        | JsonValue
        | undefined,
      isError: Boolean(record.isError),
      createdAt,
    },
  ];
}

function keepOnlySurfacedAssistant(items: ChatTimelineItem[]): ChatTimelineItem[] {
  const result: ChatTimelineItem[] = [];
  let lastAssistantIdx = -1;

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const isAssistantMsg = item.kind === "message" && item.role === "assistant";
    const isUserMsg = item.kind === "message" && item.role === "user";

    if (isAssistantMsg) {
      lastAssistantIdx = i;
      continue;
    }

    if (isUserMsg && lastAssistantIdx >= 0) {
      result.push(items[lastAssistantIdx]!);
      lastAssistantIdx = -1;
    }

    result.push(item);
  }

  if (lastAssistantIdx >= 0) {
    result.push(items[lastAssistantIdx]!);
  }

  return result;
}

function stripThinkingFromMessage(item: ChatTimelineItem): ChatTimelineItem {
  if (item.kind !== "message" || item.role !== "assistant") return item;
  const msg = item as ChatTimelineMessage;
  if (!msg.blocks?.length) return item;
  const textBlocks = msg.blocks.filter((b) => b.type === "text");
  if (textBlocks.length === 0) return item;
  const textOnly = textBlocks.map((b) => (b as { type: "text"; text: string }).text).join("\n\n");
  return { ...msg, content: textOnly, blocks: textBlocks };
}

function keepOnlySurfaced(items: ChatTimelineItem[]): ChatTimelineItem[] {
  return keepOnlySurfacedAssistant(items)
    .filter(
      (item) => item.kind === "message" && (item.role === "user" || item.role === "assistant"),
    )
    .map(stripThinkingFromMessage);
}

function shapeHistoryItems(
  items: ChatTimelineItem[],
  mode: StreamsHistoryMode,
): ChatTimelineItem[] {
  return mode === "input" ? keepOnlySurfaced(items) : items;
}

function entriesToTimeline(entries: SessionEntry[]): ChatTimelineItem[] {
  const entryIds = new Set(entries.map((entry) => entry.id));
  const compactionsByFirstKeptId = new Map<string, SessionEntry[]>();
  for (const entry of entries) {
    if (entry.type !== "compaction" || !entryIds.has(entry.firstKeptEntryId)) continue;
    const compactions = compactionsByFirstKeptId.get(entry.firstKeptEntryId) ?? [];
    compactions.push(entry);
    compactionsByFirstKeptId.set(entry.firstKeptEntryId, compactions);
  }

  const orderedEntries: SessionEntry[] = [];
  for (const entry of entries) {
    const compactions = compactionsByFirstKeptId.get(entry.id);
    if (compactions) orderedEntries.push(...compactions);
    if (entry.type !== "compaction" || !entryIds.has(entry.firstKeptEntryId)) {
      orderedEntries.push(entry);
    }
  }

  const items: ChatTimelineItem[] = [];
  for (const entry of orderedEntries) {
    if (entry.type === "compaction") {
      const record = asRecord(entry);
      const summary = firstText(record.summary);
      if (summary?.trim()) {
        items.push({
          id: entry.id,
          piEntryId: entry.id,
          kind: "message",
          role: "user",
          content: summary,
          compaction: true,
          createdAt: isoTimestamp(record.timestamp, entry.timestamp),
        });
      }
      continue;
    }
    if (entry.type === "custom_message") {
      const record = asRecord(entry);
      if (record.customType === "flitterbot-hook") {
        const content = firstText(record.content);
        if (content) {
          items.push({
            id: entry.id,
            piEntryId: entry.id,
            kind: "message",
            role: "user",
            content,
            source: "hook",
            createdAt: isoTimestamp(record.timestamp, entry.timestamp),
          });
        }
      }
      continue;
    }
    if (entry.type !== "message") continue;
    const messageRecord = asRecord(entry.message);
    const createdAt = isoTimestamp(messageRecord.timestamp, entry.timestamp);
    items.push(
      ...piMessageToTimelineItems(messageRecord, {
        messageId: conversationMessageId(messageRecord) ?? entry.id,
        createdAt,
        piEntryId: entry.id,
      }),
    );
  }
  return items;
}

function isVisibleRow(item: ChatTimelineItem): boolean {
  return item.kind === "message" && (item.role === "user" || item.role === "assistant");
}

export function encodeHistoryCursor(item: ChatTimelineItem, index: number): string {
  return Buffer.from(JSON.stringify({ v: 1, id: item.id, i: index }), "utf8").toString("base64url");
}

export type HistoryCursor = { id: string; index: number };

export function decodeHistoryCursor(raw: string): HistoryCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (record.v !== 1) return null;
  if (typeof record.id !== "string" || !record.id) return null;
  if (typeof record.i !== "number" || !Number.isInteger(record.i) || record.i < 0) return null;
  return { id: record.id, index: record.i };
}

export function clampVisibleRowLimit(raw: string | null): number {
  if (raw === null || raw.trim() === "") return STREAMS_HISTORY_DEFAULT_VISIBLE_ROW_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return STREAMS_HISTORY_DEFAULT_VISIBLE_ROW_LIMIT;
  const truncated = Math.trunc(parsed);
  if (truncated < 1) return 1;
  if (truncated > STREAMS_HISTORY_MAX_VISIBLE_ROW_LIMIT)
    return STREAMS_HISTORY_MAX_VISIBLE_ROW_LIMIT;
  return truncated;
}

type HistoryPage = {
  items: ChatTimelineItem[];
  olderPageCursor: string | null;
};

export function takePageEndingBeforeCursor(
  items: ChatTimelineItem[],
  visibleRowLimit: number,
  cursor: HistoryCursor | null,
): HistoryPage | null {
  let endExclusive = items.length;
  if (cursor) {
    const atIndex = items[cursor.index];
    if (atIndex && atIndex.id === cursor.id) {
      endExclusive = cursor.index;
    } else {
      const found = items.findIndex((item) => item.id === cursor.id);
      if (found < 0) return null;
      endExclusive = found;
    }
  }

  let firstItemOfPage = 0;
  let visibleRowsTaken = 0;
  for (let i = endExclusive - 1; i >= 0; i--) {
    if (!isVisibleRow(items[i]!)) continue;
    visibleRowsTaken++;
    if (visibleRowsTaken === visibleRowLimit) {
      firstItemOfPage = i;
      break;
    }
  }

  const hasOlderRows = items.slice(0, firstItemOfPage).some(isVisibleRow);
  return {
    items: items.slice(hasOlderRows ? firstItemOfPage : 0, endExclusive),
    olderPageCursor: hasOlderRows
      ? encodeHistoryCursor(items[firstItemOfPage]!, firstItemOfPage)
      : null,
  };
}

export function readStreamsHistoryFromSession(
  sessionManager: SessionManager,
  mode: StreamsHistoryMode = "agent",
): ChatTimelineItem[] {
  return shapeHistoryItems(entriesToTimeline(sessionManager.getBranch()), mode);
}

export function readStreamsHistory(
  piSessionId: string,
  sessionFile: string,
  mode: StreamsHistoryMode = "agent",
): ChatTimelineItem[] {
  if (!fs.existsSync(sessionFile)) {
    console.warn(
      "readStreamsHistory: session file missing on disk (sessionId=%s, file=%s)",
      piSessionId,
      sessionFile,
    );
    return [];
  }

  let raw: string;
  try {
    raw = fs.readFileSync(sessionFile, "utf8");
  } catch (err) {
    console.warn(
      "readStreamsHistory: failed to read session file (sessionId=%s, file=%s): %s",
      piSessionId,
      sessionFile,
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }

  const fileEntries = parseSessionEntries(raw);
  const entries: SessionEntry[] = [];
  const byId = new Map<string, SessionEntry>();
  for (const fe of fileEntries) {
    if (fe.type === "session") continue;
    entries.push(fe);
    byId.set(fe.id, fe);
  }

  if (entries.length === 0) return [];

  const leaf = entries[entries.length - 1]!;
  const path: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  while (current) {
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  return shapeHistoryItems(entriesToTimeline(path), mode);
}
