import fs from "node:fs";
import {
  parseSessionEntries,
  type SessionEntry,
  type SessionManager,
} from "@mariozechner/pi-coding-agent";
import type {
  ChatTimelineItem,
  ChatTimelineMessage,
  ChatTimelineTool,
  ImageAttachment,
  JsonValue,
  StreamsHistoryResponse,
} from "../contracts/index.ts";

type StreamsHistoryMode = "agent" | "input";

type StreamsHistoryMessageBlock = NonNullable<ChatTimelineMessage["blocks"]>[number];

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
  blocks?: StreamsHistoryMessageBlock[],
  images?: ImageAttachment[],
): void {
  const normalized = content.trim();
  const normalizedBlocks = blocks?.filter((block) =>
    block.type === "text" ? block.text.trim() : block.thinking.trim(),
  );
  if (
    !normalized &&
    (!normalizedBlocks || normalizedBlocks.length === 0) &&
    (!images || images.length === 0)
  )
    return;

  const item: ChatTimelineMessage = {
    id,
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
  items.push(item);
}

function parseMessageContent(
  items: ChatTimelineItem[],
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

  const messageBlocks: StreamsHistoryMessageBlock[] = [];
  const imageAttachments: ImageAttachment[] = [];
  let textBuffer = "";

  const flushTextBlock = () => {
    if (!textBuffer.trim()) return;
    messageBlocks.push({ type: "text", text: textBuffer });
    textBuffer = "";
  };

  const flushMessage = () => {
    flushTextBlock();
    const images = imageAttachments.length > 0 ? [...imageAttachments] : undefined;
    imageAttachments.length = 0;
    if (messageBlocks.length === 0 && !images) return;
    const contentText = messageBlocks
      .map((block) => (block.type === "text" ? block.text : block.thinking))
      .join("\n\n");
    pushMessage(items, messageId, role, contentText, createdAt, [...messageBlocks], images);
    messageBlocks.length = 0;
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

    if (type === "toolCall") {
      flushMessage();
      const toolUseId = typeof record.id === "string" ? record.id : `unknown-${messageId}`;
      items.push({
        id: `tool-${toolUseId}-start`,
        kind: "tool",
        tool: typeof record.name === "string" && record.name.trim() ? record.name : "unknown_tool",
        phase: "start",
        toolUseId,
        args: record.arguments as JsonValue | undefined,
        createdAt,
      });
    }
  }

  flushMessage();
}

function parseMessageRecord(
  messageRecord: Record<string, unknown>,
  createdAt: string,
  messageId: string,
  items: ChatTimelineItem[],
): void {
  const role = messageRecord.role;

  if (role === "user" || role === "assistant" || role === "system") {
    parseMessageContent(items, messageId, role, createdAt, messageRecord.content);
    return;
  }

  if (role === "toolResult") {
    const item = toolResultMessageToTimelineItem(messageRecord, messageId, createdAt);
    if (item) items.push(item);
  }
}

export function toolResultMessageToTimelineItem(
  message: unknown,
  messageId: string,
  createdAt: string,
): ChatTimelineTool | undefined {
  const messageRecord = asRecord(message);
  if (messageRecord.role !== "toolResult") return undefined;

  const resultText = firstText(messageRecord.content);
  const toolCallId =
    typeof messageRecord.toolCallId === "string"
      ? messageRecord.toolCallId
      : `unknown-${messageId}`;

  return {
    id: `tool-${toolCallId}-end`,
    kind: "tool",
    tool:
      typeof messageRecord.toolName === "string" && messageRecord.toolName.trim()
        ? messageRecord.toolName
        : "unknown_tool",
    phase: "end",
    toolUseId: toolCallId,
    result: (messageRecord.details ?? resultText) as JsonValue | undefined,
    isError: Boolean(messageRecord.isError),
    createdAt,
  };
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
      continue; // defer — only emit the last one per turn
    }

    if (isUserMsg && lastAssistantIdx >= 0) {
      result.push(items[lastAssistantIdx]!);
      lastAssistantIdx = -1;
    }

    result.push(item);
  }

  // Flush trailing assistant message (last turn with no following user message)
  if (lastAssistantIdx >= 0) {
    result.push(items[lastAssistantIdx]!);
  }

  return result;
}

/**
 * Strip everything except user messages and the final surfaced assistant message per turn.
 * This mirrors the WhatsApp / InputSurface live path: no tools, no system messages.
 */
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

/**
 * Walk a list of SessionEntry objects (already ordered root→leaf) and build
 * timeline items keyed by the SDK's persistent entry.id. The same id is
 * what pi-subscribe broadcasts on live `message_end` (read back via
 * sessionManager.getLeafId() once the SDK has appended the entry), so the
 * cache identity is stable across live streaming and disk reload — no
 * parallel ordinal counter to keep in sync. The id also doubles as the
 * prune target since `navigateTree(entryId)` accepts it directly.
 *
 * Non-message entries (thinking_level_change, model_change, compaction,
 * custom, label, session_info, branch_summary) are skipped here — the chat
 * timeline only renders conversational content.
 */
function entriesToTimeline(entries: SessionEntry[]): ChatTimelineItem[] {
  const items: ChatTimelineItem[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const messageRecord = asRecord(entry.message);
    const createdAt = isoTimestamp(messageRecord.timestamp, entry.timestamp);
    parseMessageRecord(messageRecord, createdAt, entry.id, items);
  }
  return items;
}

/**
 * Build history from a live AgentSession's SessionManager, walking the current
 * leaf's branch path (root → leaf). Entries not on the current branch (e.g.
 * pruned siblings) are excluded.
 */
export function readStreamsHistoryFromSession(
  piSessionId: string,
  sessionManager: SessionManager,
  mode: StreamsHistoryMode = "agent",
): StreamsHistoryResponse {
  const sessionFile = sessionManager.getSessionFile() ?? null;
  const branch = sessionManager.getBranch();
  const items = entriesToTimeline(branch);
  return {
    piSessionId,
    sessionFile,
    items: shapeHistoryItems(items, mode),
  };
}

/**
 * Build history from an on-disk session JSONL file. Resolves the leaf (last
 * entry in the file) and walks back to root via parentId pointers, emitting
 * only entries on the active branch. This mirrors SessionManager's leaf
 * resolution and ensures pruned branches are invisible to dormant readers.
 */
export function readStreamsHistory(
  piSessionId: string,
  sessionFile: string,
  mode: StreamsHistoryMode = "agent",
): StreamsHistoryResponse {
  if (!fs.existsSync(sessionFile)) {
    console.warn(
      "readStreamsHistory: session file missing on disk (sessionId=%s, file=%s)",
      piSessionId,
      sessionFile,
    );
    return {
      piSessionId,
      sessionFile,
      items: [],
    };
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
    return { piSessionId, sessionFile, items: [] };
  }

  const fileEntries = parseSessionEntries(raw);
  // Strip header; keep only SessionEntry (non-"session" types).
  const entries: SessionEntry[] = [];
  const byId = new Map<string, SessionEntry>();
  for (const fe of fileEntries) {
    if (fe.type === "session") continue;
    entries.push(fe);
    byId.set(fe.id, fe);
  }

  if (entries.length === 0) {
    return { piSessionId, sessionFile, items: [] };
  }

  // Leaf = last entry in file (matches SessionManager._buildIndex behaviour).
  // Walk leaf → root collecting the active branch path.
  const leaf = entries[entries.length - 1]!;
  const path: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  while (current) {
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  const items = entriesToTimeline(path);
  return {
    piSessionId,
    sessionFile,
    items: shapeHistoryItems(items, mode),
  };
}
