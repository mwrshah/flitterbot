import type {
  ConversationSnippet,
  DefaultConversationSnippet,
} from "../blackboard/query-messages.ts";
import type { StreamRow } from "../contracts/index.ts";

export type ClassifierPrompts = {
  systemPrompt: string;
  userPrompt: string;
};

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

const SNIPPET_MAX_CHARS = 600;

function truncate(text: string, max: number = SNIPPET_MAX_CHARS): string {
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
    return `    ${label}: ${truncate(collapseNewlines(s.content))} (${relativeTime(s.created_at)})`;
  });
  return `${header}\n${messageLines.join("\n")}`;
}

function formatDefaultConversation(snippets: DefaultConversationSnippet[]): string {
  if (snippets.length === 0) return "(no recent conversation)";
  return snippets
    .map((s) => {
      const label = s.direction === "outbound" ? "Agent" : "User";
      return `  ${label}: ${truncate(collapseNewlines(s.content))} (${relativeTime(s.created_at)})`;
    })
    .join("\n");
}

export const ROUTER_CLASSIFIER_SYSTEM_PROMPT = `You are a message router for a software development assistant.

Decide whether the user's message belongs to an existing open stream, or whether it should go to the default agent.

Rules:
1. Recent conversation snippets are shown newest first.
2. If the message clearly relates to an existing open stream, return its id.
3. If the message does not match any open stream, return stream_id: null. The default agent will handle it.
4. Use the recent conversation snippets to understand context. Short/ambiguous user replies ("yes", "sure", "do it") almost certainly respond to the stream OR default agent conversation with the most recent agent message. Check both the stream marked "← last agent response" and the default agent conversation to decide.
5. If the user appears to be continuing the default agent conversation (e.g. replying to something the default agent said), return stream_id: null.
6. Brainstorm streams are open-ended ideation sessions for a repo. If the user's message is general brainstorming, ideation, or exploratory discussion about a repo that has an open brainstorm stream, route to that brainstorm stream. Exception: if there is a different stream for the same repo that covers a specific issue the message clearly relates to, route to that specific stream instead. Specific beats general.
7. If the user asks to create a new stream, start new work, or requests something that doesn't belong to any existing stream, return stream_id: null. Only the default agent can create streams.
8. When in doubt, return stream_id: null — prefer routing to the default agent over a wrong match.

Respond with ONLY a JSON object containing two fields: stream_id and reasoning. No other text or explanation.`;

export function buildClassificationPrompts(
  message: string,
  streams: StreamRow[],
  recentConversation: Map<string, ConversationSnippet[]>,
  defaultConversation: DefaultConversationSnippet[] = [],
): ClassifierPrompts {
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

  return {
    systemPrompt: ROUTER_CLASSIFIER_SYSTEM_PROMPT,
    userPrompt: `## Open streams — recent messages newest first
${streamBlock}

## Default agent conversation — recent messages newest first
${defaultBlock}

## User message
${message}`,
  };
}
