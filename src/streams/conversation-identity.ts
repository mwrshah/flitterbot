import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

type IdentifiedMessage = Record<string, unknown> & { flitterbotMessageId?: string };

export function ensureConversationMessageId(
  message: unknown,
  preferredId?: string,
): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const identified = message as IdentifiedMessage;
  if (typeof identified.flitterbotMessageId === "string" && identified.flitterbotMessageId) {
    return identified.flitterbotMessageId;
  }
  const id = preferredId?.trim() || crypto.randomUUID();
  identified.flitterbotMessageId = id;
  return id;
}

export function conversationMessageId(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const id = (message as IdentifiedMessage).flitterbotMessageId;
  return typeof id === "string" && id ? id : undefined;
}

type EntryIndex = {
  scanned: number;
  entriesByMessageId: Map<string, SessionEntry>;
};

const indexes = new WeakMap<SessionManager, EntryIndex>();

export function findConversationEntry(
  sessionManager: SessionManager,
  messageId: string,
): SessionEntry | undefined {
  const entries = sessionManager.getEntries();
  let index = indexes.get(sessionManager);
  if (!index || entries.length < index.scanned) {
    index = { scanned: 0, entriesByMessageId: new Map() };
    indexes.set(sessionManager, index);
  }
  for (let position = index.scanned; position < entries.length; position += 1) {
    const entry = entries[position];
    if (entry?.type !== "message") continue;
    const id = conversationMessageId(entry.message);
    if (id) index.entriesByMessageId.set(id, entry);
  }
  index.scanned = entries.length;
  return index.entriesByMessageId.get(messageId);
}
