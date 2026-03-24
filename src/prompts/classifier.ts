import type { ConversationSnippet } from "../blackboard/query-messages.ts";
import type { WorkstreamRow } from "../contracts/index.ts";

function formatWorkstreamLine(ws: WorkstreamRow, label?: string): string {
  const suffix = label ? ` ${label}` : "";
  return `- id: "${ws.id}", name: "${ws.name}"${suffix}${ws.repo_path ? `, repo: ${ws.repo_path}` : ""}`;
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 0) return "just now";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

function collapseNewlines(text: string): string {
  return text.replace(/\n/g, " ").trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function findLastAgentResponseWorkstream(
  recentConversation: Map<string, ConversationSnippet[]>,
): string | null {
  let latestWsId: string | null = null;
  let latestTime = "";
  for (const [wsId, snippets] of recentConversation) {
    for (const s of snippets) {
      if (s.direction === "outbound" && s.created_at > latestTime) {
        latestTime = s.created_at;
        latestWsId = wsId;
      }
    }
  }
  return latestWsId;
}

function formatWorkstreamWithConversation(
  ws: WorkstreamRow,
  snippets: ConversationSnippet[] | undefined,
  isLastAgentResponse: boolean,
): string {
  const marker = isLastAgentResponse ? " ← last agent response" : "";
  const header = formatWorkstreamLine(ws, marker || undefined);
  if (!snippets || snippets.length === 0) return header;

  const messageLines = snippets.map((s) => {
    const label = s.direction === "outbound" ? "Agent" : "User";
    return `    [${s.source}] ${label}: ${truncate(collapseNewlines(s.content), 200)} (${relativeTime(s.created_at)})`;
  });
  return `${header}\n${messageLines.join("\n")}`;
}

export function buildClassificationPrompt(
  message: string,
  workstreams: WorkstreamRow[],
  recentConversation: Map<string, ConversationSnippet[]>,
): string {
  const latestAgentWsId = findLastAgentResponseWorkstream(recentConversation);
  const workstreamBlock =
    workstreams.length > 0
      ? workstreams
          .map((ws) =>
            formatWorkstreamWithConversation(
              ws,
              recentConversation.get(ws.id),
              ws.id === latestAgentWsId,
            ),
          )
          .join("\n")
      : "(none open)";

  return `You are a message router for a software development assistant.

Given a user message, decide if it relates to an existing open workstream.

## Open workstreams
${workstreamBlock}

## Rules
1. If the message clearly relates to an existing open workstream, return its id.
2. If the message does not match any open workstream, return workstream_id: null. The default agent will handle it.
3. Use the recent conversation snippets to understand context. Short/ambiguous user replies ("yes", "sure", "do it") almost certainly respond to the workstream with the most recent agent message (marked with "← last agent response").
4. If the user asks to create a new workstream, start new work, or requests something that doesn't belong to any existing workstream, return workstream_id: null. Only the default agent can create workstreams.
5. When in doubt, return workstream_id: null — prefer routing to the default agent over a wrong match.

## Response format
Respond with ONLY a JSON object containing two fields: workstream_id and reasoning. No other text or explanation. Example:
\`\`\`json
{
  "workstream_id": null,
  "reasoning": "No matching open workstream — routing to default agent"
}
\`\`\`

## User message
${message}`;
}
