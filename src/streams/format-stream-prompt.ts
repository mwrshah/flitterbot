import { formatDatetimeBlock } from "../prompts/datetime.ts";

const DATETIME_BLOCK_PATTERN = String.raw`\[Now: [^\]]+\]`;
const LEADING_DATETIME_BLOCK_RE = new RegExp(`^${DATETIME_BLOCK_PATTERN}\\s*`, "u");
const TRAILING_DATETIME_BLOCK_RE = new RegExp(`\\s*${DATETIME_BLOCK_PATTERN}$`, "u");

export function stripInjectedDatetimeBlocks(text: string): string {
  return text.replace(LEADING_DATETIME_BLOCK_RE, "").replace(TRAILING_DATETIME_BLOCK_RE, "");
}

export function formatStreamPrompt(
  messages: string[],
  _streamName: string,
  _streamId: string,
  agentMessage?: string,
  footer?: string,
): string {
  let body = messages[0] ?? "";

  if (messages.length > 1) {
    body = messages
      .map((m, i) => {
        const label = i === messages.length - 1 ? `(CURRENT)` : `(${i + 1}/${messages.length})`;
        return `User message ${label}:\n${m}`;
      })
      .join("\n\n");
  }

  let agentSection = "";
  if (messages.length === 0 && agentMessage) {
    agentSection = agentMessage;
  } else if (messages.length > 0 && agentMessage) {
    agentSection = `\n\nAdditional context:\n${agentMessage}`;
  }

  const footerSection = footer?.trim() ? `\n---\nStream setup:\n${footer.trim()}` : "";

  const datetime = formatDatetimeBlock();

  return `${body}${agentSection}${footerSection}\n\n${datetime}`;
}
