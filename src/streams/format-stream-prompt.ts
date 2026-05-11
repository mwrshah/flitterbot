import { formatDatetimeBlock } from "../prompts/datetime.ts";

const DATETIME_BLOCK_PATTERN = String.raw`\[Now: [^\]]+\]`;
const LEADING_DATETIME_BLOCK_RE = new RegExp(`^${DATETIME_BLOCK_PATTERN}\\s*`, "u");
const TRAILING_DATETIME_BLOCK_RE = new RegExp(`\\s*${DATETIME_BLOCK_PATTERN}$`, "u");

export function stripInjectedDatetimeBlocks(text: string): string {
  return text.replace(LEADING_DATETIME_BLOCK_RE, "").replace(TRAILING_DATETIME_BLOCK_RE, "");
}

/**
 * Format the initial prompt for a new stream orchestrator.
 * Accepts one or more user messages as context, an optional agent-authored
 * message, and an optional configured footer. Appends the current datetime as a
 * tail block so the prompt's leading content is the user's own message —
 * preserving any leading `/skill:<name>` token that the pi-sdk expands when the
 * user message is at the head of the prompt.
 */
export function formatStreamPrompt(
  messages: string[],
  _streamName: string,
  _streamId: string,
  agentMessage?: string,
  footer?: string,
): string {
  const datetime = formatDatetimeBlock();
  const agentSection = agentMessage ? `\n\nAdditional context:\n${agentMessage}` : "";
  const footerSection = footer?.trim() ? `\n---\nStream setup:\n${footer.trim()}` : "";

  if (messages.length <= 1) {
    const head = `${messages[0] ?? ""}${agentSection}${footerSection}`;
    return head ? `${head}\n\n${datetime}` : datetime;
  }

  const total = messages.length;
  const body = messages
    .map((m, i) => {
      const label = i === total - 1 ? `${i + 1}/${total}, CURRENT` : `${i + 1}/${total}`;
      return `User message (${label}):\n${m}`;
    })
    .join("\n\n");

  return `Stream Context:\n\n${body}${agentSection}${footerSection}\n\n${datetime}`;
}
