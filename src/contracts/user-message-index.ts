export type UserMessageIndexEntry = { id: string; content: string };

export function toUserMessageIndexEntry(message: {
  id: string;
  content: string;
}): UserMessageIndexEntry {
  const { id, content } = message;
  if (content.length <= 500) return { id, content };

  let end = 499; // Reserve one UTF-16 unit for the ellipsis.
  const before = content.charCodeAt(end - 1);
  const after = content.charCodeAt(end);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end--;
  return { id, content: `${content.slice(0, end)}…` };
}
