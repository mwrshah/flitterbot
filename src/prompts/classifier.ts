import type {
  ConversationSnippet,
  DefaultConversationSnippet,
} from "../blackboard/query-messages.ts";
import type { StreamRow } from "../contracts/index.ts";

function formatStreamLine(ws: StreamRow, label?: string): string {
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

function findLastAgentResponseStream(
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

function formatStreamWithConversation(
  ws: StreamRow,
  snippets: ConversationSnippet[] | undefined,
  isLastAgentResponse: boolean,
): string {
  const marker = isLastAgentResponse ? " ← last agent response" : "";
  const header = formatStreamLine(ws, marker || undefined);
  if (!snippets || snippets.length === 0) return header;

  const messageLines = snippets.map((s) => {
    const label = s.direction === "outbound" ? "Agent" : "User";
    return `    [${s.source}] ${label}: ${truncate(collapseNewlines(s.content), 200)} (${relativeTime(s.created_at)})`;
  });
  return `${header}\n${messageLines.join("\n")}`;
}

function formatDefaultConversation(snippets: DefaultConversationSnippet[]): string {
  if (snippets.length === 0) return "(no recent conversation)";
  return snippets
    .map((s) => {
      const label = s.direction === "outbound" ? "Agent" : "User";
      return `  [${s.source}] ${label}: ${truncate(collapseNewlines(s.content), 200)} (${relativeTime(s.created_at)})`;
    })
    .join("\n");
}

export function buildClassificationPrompt(
  message: string,
  streams: StreamRow[],
  recentConversation: Map<string, ConversationSnippet[]>,
  defaultConversation: DefaultConversationSnippet[] = [],
): string {
  const latestAgentStreamId = findLastAgentResponseStream(recentConversation);
  const streamBlock =
    streams.length > 0
      ? streams
          .map((ws) =>
            formatStreamWithConversation(
              ws,
              recentConversation.get(ws.id),
              ws.id === latestAgentStreamId,
            ),
          )
          .join("\n")
      : "(none open)";

  const defaultBlock = formatDefaultConversation(defaultConversation);

  return `You are a message router for a software development assistant.

Given a user message, decide if it relates to an existing open stream.

## Open streams
${streamBlock}

## Default agent conversation
${defaultBlock}

## Rules
1. If the message clearly relates to an existing open stream, return its id.
2. If the message does not match any open stream, return stream_id: null. The default agent will handle it.
3. Use the recent conversation snippets to understand context. Short/ambiguous user replies ("yes", "sure", "do it") almost certainly respond to the stream OR default agent conversation with the most recent agent message. Check both the stream marked "← last agent response" and the default agent conversation to decide.
4. If the user appears to be continuing the default agent conversation (e.g. replying to something the default agent said), return stream_id: null.
5. *Brainstorm streams* — streams with "brainstorm" in the name are open-ended ideation sessions for a repo. If the user's message is general brainstorming, ideation, or exploratory discussion about a repo that has an open brainstorm stream, route to that brainstorm stream — do NOT let it fall through to the default agent. Exception: if there is a *different* stream for the same repo that covers a specific issue the message clearly relates to, route to that specific stream instead. Specific beats general.
6. If the user asks to create a new stream, start new work, or requests something that doesn't belong to any existing stream, return stream_id: null. Only the default agent can create streams.
7. When in doubt, return stream_id: null — prefer routing to the default agent over a wrong match.

## Response format
Respond with ONLY a JSON object containing two fields: stream_id and reasoning. No other text or explanation. Example:
\`\`\`json
{
  "stream_id": null,
  "reasoning": "No matching open stream — routing to default agent"
}
\`\`\`

## User message
${message}`;
}
