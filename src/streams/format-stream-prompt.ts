/**
 * Format the initial prompt for a new stream orchestrator.
 * Accepts one or more user messages as context, and an optional agent-authored message.
 */
export function formatStreamPrompt(
  messages: string[],
  _streamName: string,
  _streamId: string,
  agentMessage?: string,
): string {
  const footer = "IMPORTANT: Before doing anything else, run /load2-w to load essential skills.";
  const agentSection = agentMessage ? `\n\n--- Agent context ---\n${agentMessage}` : "";

  if (messages.length <= 1) {
    return `${messages[0] ?? ""}${agentSection}\n\n${footer}`;
  }

  const total = messages.length;
  const body = messages
    .map((m, i) => {
      const label = i === total - 1 ? `${i + 1}/${total}, most recent` : `${i + 1}/${total}`;
      return `--- User message (${label}) ---\n${m}`;
    })
    .join("\n\n");

  return `The following user messages provide context for this stream:\n\n${body}${agentSection}\n\n${footer}`;
}
