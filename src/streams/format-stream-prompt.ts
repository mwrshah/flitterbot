import { formatDatetimeBlock } from "../prompts/datetime.ts";

/**
 * Format the initial prompt for a new stream orchestrator.
 * Accepts one or more user messages as context, and an optional agent-authored message.
 * Prepends the current datetime so the orchestrator knows the time from its first message.
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
    return `${datetime}\n${messages[0] ?? ""}${agentSection}`;
  }

  const total = messages.length;
  const body = messages
    .map((m, i) => {
      const label = i === total - 1 ? `${i + 1}/${total}, most recent` : `${i + 1}/${total}`;
      return `--- User message (${label}) ---\n${m}`;
    })
    .join("\n\n");

  return `${datetime}\nThe following user messages provide context for this stream:\n\n${body}${agentSection}`;
}
