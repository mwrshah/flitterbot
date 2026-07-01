import type {
  ConversationSnippet,
  DefaultConversationSnippet,
} from "../blackboard/query-messages.ts";
import type { StreamRow } from "../contracts/index.ts";

export type ClassifierPrompts = {
  systemPrompt: string;
  userPrompt: string;
};

function formatStreamHeader(ws: StreamRow, label?: string): string {
  const marker = label ? ` ${label}` : "";
  const lines = [`\n### Name: ${ws.name}${marker}`, `- stream_id: "${ws.id}"`];
  if (ws.repo_path) lines.push(`    repo: ${ws.repo_path}`);
  return lines.join("\n");
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
  const header = formatStreamHeader(ws, marker || undefined);
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

export const ROUTER_CLASSIFIER_SYSTEM_PROMPT = `Decide whether to send the user's message to an existing open stream or to the default agent.

Return stream_id: null when the default agent should handle it. Otherwise return the matching stream id.

You will be shown the last few messages in each open stream and in the default agent conversation. Recent conversation snippets are shown newest first, in reverse chronological order.

Rules:
1. If the user references the name (what is value of "### Name:") in their message: you should route to that stream. e.g. "Hey flitty" when referencing: "### Name: flitty (a.k.a flits, flitter)"
2. Route to an open stream only when the message is substantively connected to that stream's specific task or discussion. A repo match is not enough. If the conversation snippets are about the same topic, or the user appears to be continuing the conversation happening in an open stream, choose that stream. A different task in the same repo should go to the default agent so it can start new work.
3. Short replies like "yes", "sure", or "do it" usually answer the most recent agent message. Check both open streams and the default agent conversation, then choose the best match.
4. If the user asks to start new work, create a new stream, or do something that does not belong to an existing stream, return stream_id: null.
5. If the message is exactly /clear, /reload, or /compact, including /compact with instructions, return stream_id: null.
6. When unsure, return stream_id: null to fall back to the default agent.

Respond with ONLY a JSON object containing stream_id and reasoning.`;

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
