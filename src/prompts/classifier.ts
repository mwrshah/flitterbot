import type { WorkstreamRow } from "../contracts/index.ts";
import type { ConversationSnippet } from "../blackboard/queries/messages.ts";

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
  recentlyClosed: WorkstreamRow[],
  recentConversation: Map<string, ConversationSnippet[]>,
  projects: string[],
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

  const closedBlock =
    recentlyClosed.length > 0
      ? recentlyClosed.map((ws) => formatWorkstreamLine(ws, "[closed]")).join("\n")
      : "(none)";

  const projectBlock = projects.length > 0 ? projects.join(", ") : "(none)";

  return `You are a message classifier for a software development assistant.

Given a user message, classify it against open workstreams and known projects.

## Open workstreams
${workstreamBlock}

## Recently closed workstreams (last 6 hours)
${closedBlock}

## Known projects
${projectBlock}

## Rules
1. If the message clearly relates to an existing open workstream, return its id.
2. If the message starts new work (a task, bug, feature, investigation, etc.) that doesn't match any open workstream, set new_workstream_name to a short descriptive name (2-5 words, lowercase, dash-separated).
3. If the message is casual conversation, a greeting, or otherwise not work-related, set is_work_message to false and leave both ids null. NOTE: questions about how Autonoma's own code works (router, prompts, session manager, blackboard, etc.) are NOT "questions about the assistant" — they are engineering investigation and count as work (see rule 11).
4. If the user explicitly asks to start/open/create a new workstream (e.g. "start a new workstream", "open a new workstream for this", "create a separate workstream"), ALWAYS create a new workstream regardless of whether the topic overlaps with an existing one. User intent overrides matching heuristics.
5. When in doubt between matching an existing workstream and creating a new one, prefer matching the existing one.
6. A message that references a known project by name should be matched to an existing workstream for that project if one exists, or trigger a new workstream if not.
7. If the message relates to a recently closed workstream, return its id. Do not create a duplicate workstream for recently completed work.
8. Use the recent conversation snippets to understand context when deciding if the message relates to an existing workstream. Agent messages show what the assistant last said to the user — short/ambiguous user replies (e.g. "yes", "sure", "do it") are almost certainly responding to the workstream that sent the most recent agent message (marked with "← last agent response").
9. Session management commands (kill tmux, close sessions, check status, restart daemon, close tmux windows, quit claude) are NOT work — set is_work_message to false. These are infrastructure meta-operations.
10. Cron health-check messages (containing "Cron idle check", "Cron stale session check", or similar automated system messages) are NOT work — set is_work_message to false.
11. IMPORTANT — Autonoma self-work override: Workstreams are about repository-scoped coding/engineering work (features, bugs, investigations in a project) — including work on Autonoma's own code (prompts, router, session manager, blackboard, control surface, etc.), since Autonoma is itself a known project. Questions like "how does the router work", "show me the prompt structure", or "what does the classifier do" are engineering investigation that leads to code changes — they ARE work and MUST get a workstream. This rule takes priority over rule 3. Rules 9-10 already exclude session management commands and cron checks; everything else that touches code in a known project IS work.

## Response format
Respond with ONLY a JSON object containing four fields: workstream_id, new_workstream_name, is_work_message, and reasoning. No other text or explanation. Example:
\`\`\`json
{
  "is_work_message": true,
  "workstream_id": null,
  "new_workstream_name": "input-surface-websocket-investigation",
  "reasoning": "New investigation into websocket streaming issue distinct from existing steer-type workstream"
}
\`\`\`

## User message
${message}`;
}
