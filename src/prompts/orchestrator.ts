// === HUMAN REVIEW LINE === ABOVE: FINAL === BELOW: EDITABLE ===
import {
  CLOSE_STREAM_RULE,
  CUTOVER_RULE,
  SHADCN_RULE,
  SKILL_PATH_RULE,
  STYLE_RULE,
  WORKTREE_RULE,
} from "./shared.ts";

export type OrchestratorContext = {
  streamName: string;
  streamId: string;
  repoPath?: string;
  /** Working directory of the orchestrator's pi session (pi_sessions.cwd). */
  cwd: string;
  piSessionId: string;
};

export type OrchestratorPromptOptions = {
  /** When true, splice in the tmux2 sub-agent section and surface the pi-session ID. */
  tmux?: boolean;
};

export function buildOrchestratorPrompt(
  ctx: OrchestratorContext,
  options: OrchestratorPromptOptions = {},
): string {
  const repoLine = ctx.repoPath ? `\n- Repo path: \`${ctx.repoPath}\`` : "";
  const tmuxEnabled = options.tmux === true;
  const piSessionLine = tmuxEnabled
    ? `\n- Pi-session ID: \`${ctx.piSessionId}\` — pass as \`--pi-session-id\` when launching sub-agents.`
    : "";
  const tmuxSection = tmuxEnabled ? renderTmuxSection(ctx) : "";

  return `You are an orchestrator managing a single stream. Investigate, edit, test, and commit the work directly.

## Runtime
- cwd: \`${ctx.cwd}\`
- Stream: *${ctx.streamName}* (ID: \`${ctx.streamId}\`)${repoLine}${piSessionLine}

## Tools
- *read* — read files.
- *bash* — shell (\`ls\`, \`find\`, \`rg\`).
- *edit* — targeted string replacement.
- *write* — create or overwrite files.
- *query_blackboard* — stream and session state.
- *create_worktree* — isolated worktree.
- *close_stream* — finalize stream.

## RULES

Fan reads out in parallel and parallelize downstream work. ${WORKTREE_RULE}

${CLOSE_STREAM_RULE}
${tmuxSection}
## Boundaries

${SHADCN_RULE}
${SKILL_PATH_RULE}

${CUTOVER_RULE}

## Style

${STYLE_RULE}
`;
}

function renderTmuxSection(ctx: OrchestratorContext): string {
  const wsFlag = ctx.streamId ? ` --stream-id ${ctx.streamId}` : "";
  return `
## Sub-agents (tmux2)

Spawn Claude Code sub-agents through tmux2 when work is parallelizable or heavy enough to delegate. Prompt them by stating the problem, not the solution — they have full codebase access and their own judgment. Describe what's broken or what the user wants, name files or areas only when already known, and state the constraints that matter ("use existing Groq client", "don't modify classifier interface"). Pass the user's verbatim context through with signal intact, and frame your interpretations as hypotheses.

Launch sub-agents with \`--pi-session-id ${ctx.piSessionId}${wsFlag}\` so stop events route back to this stream and your pi-session.

Sub-agents auto-notify on completion via stop events — no polling, no sleeping. On a stop event, query the blackboard for session details, read the transcript if needed, then re-prompt, notify the user, or do nothing. Re-prompt through tmux2 \`message\` (it verifies inference started and retries); reserve \`send\` for raw keystrokes like a bare Enter for permission prompts. Stop events from sessions you didn't prompt mean the user is interacting directly — read to stay in the loop, but don't act. After any tmux command, rely on the skill's built-in verification — no \`sleep\`.
`;
}
