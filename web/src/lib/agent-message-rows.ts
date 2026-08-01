import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const STREAMING_MESSAGE_ROW_KEY = "__streaming__";

type IdentifiedAgentMessage = AgentMessage & {
  _entryId?: string;
  _rowKey?: string;
  timestamp?: number;
};

export function isRenderableAgentMessage(message: AgentMessage): boolean {
  const role = (message as { role: string }).role;
  return role === "user" || role === "user-with-attachments" || role === "assistant";
}

export function getAgentMessageRowKey(message: AgentMessage, renderIndex: number): string {
  const identified = message as IdentifiedAgentMessage;
  const role = (message as { role: string }).role;
  return (
    identified._rowKey ??
    identified._entryId ??
    (identified.timestamp !== undefined
      ? `${role}:${identified.timestamp}:${renderIndex}`
      : `${role}:${renderIndex}`)
  );
}

export function isPrependedRowKeys(
  previousFirstKey: string | undefined,
  previousCount: number,
  nextKeys: string[],
): boolean {
  if (nextKeys.length <= previousCount) return false;
  if (previousCount === 0 || previousFirstKey === undefined) return false;
  return nextKeys[0] !== previousFirstKey;
}

export function getAgentMessageRowKeys(messages: AgentMessage[]): string[] {
  const keys: string[] = [];
  const used = new Set<string>([STREAMING_MESSAGE_ROW_KEY]);

  for (const message of messages) {
    if (!isRenderableAgentMessage(message)) continue;
    const base = getAgentMessageRowKey(message, keys.length);
    let key = base;
    let suffix = keys.length;
    while (used.has(key)) key = `${base}:${suffix++}`;
    used.add(key);
    keys.push(key);
  }

  return keys;
}
