import { formatDatetimeBlock } from "../prompts/datetime.ts";

/**
 * Format the initial prompt for a new stream orchestrator.
 * Accepts one or more user messages as context, and an optional agent-authored message.
 * Appends the current datetime as a tail block so the prompt's leading content is
 * the user's own message — preserving any leading `/skill:<name>` token that the
 * pi-sdk expands when the user message is at the head of the prompt.
 */
export function formatStreamPrompt(
  messages: string[],
  _streamName: string,
  _streamId: string,
  agentMessage?: string,
): string {
  const datetime = formatDatetimeBlock();
  const agentSection = agentMessage ? `\n\n--- Agent context ---\n${agentMessage}` : "";

  if (messages.length <= 1) {
    const head = `${messages[0] ?? ""}${agentSection}`;
    return head ? `${head}\n\n${datetime}` : datetime;
  }

  const total = messages.length;
  const body = messages
    .map((m, i) => {
      const label = i === total - 1 ? `${i + 1}/${total}, most recent` : `${i + 1}/${total}`;
      return `--- User message (${label}) ---\n${m}`;
    })
    .join("\n\n");

  return `The following user messages provide context for this stream:\n\n${body}${agentSection}\n\n${datetime}`;
}
