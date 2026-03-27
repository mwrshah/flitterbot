/**
 * Format the initial prompt for a new workstream orchestrator.
 * Accepts one or more user messages as context, and an optional agent-authored message.
 */
export function formatWorkstreamPrompt(
  messages: string[],
  workstreamName: string,
  workstreamId: string,
  agentMessage?: string,
): string {
  const header = `[Workstream: "${workstreamName}" (${workstreamId})] [NEW]`;
  const footer = "IMPORTANT: Before doing anything else, run /load2-w to load essential skills.";
  const agentSection = agentMessage
    ? `\n\n--- Agent context ---\n${agentMessage}`
    : "";

  if (messages.length <= 1) {
    return `${header}\n${messages[0] ?? ""}${agentSection}\n\n${footer}`;
  }

  const total = messages.length;
  const body = messages
    .map((m, i) => {
      const label = i === total - 1 ? `${i + 1}/${total}, most recent` : `${i + 1}/${total}`;
      return `--- User message (${label}) ---\n${m}`;
    })
    .join("\n\n");

  return `${header}\nThe following user messages provide context for this workstream:\n\n${body}${agentSection}\n\n${footer}`;
}
