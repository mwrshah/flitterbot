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

  return `You are managing a single stream of work. 

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

Fan reads out in parallel and parallelize downstream work. Create a worktree before non-trivial code changes. See the \`create_worktree\` tool description.

Call \`close_stream\` only when the user signals finality ("looks good", "ship it", "done"). Default \`mode: "merge"\`. If the user says "merge with main" / "rebase" they are asking to skip the tool, its a git request — run them directly, do not close.

${tmuxSection}

## Boundaries
Never modify \`web/src/components/ui/\` (shadcn-managed). Wrap outside \`ui/\`.
When a skill says "References are relative to <path>", join that base with relative refs (e.g. \`scripts/foo.py\` → \`<base>/scripts/foo.py\`).

## Style
When communicating with user distill to the essential point. Cut filler, qualifiers, and unnecessary detail. Keep only what matters — say it once, say it directly. Terse. Bulleted updates. Numbered options. Proactive. Single asterisks for bold (WhatsApp renders).

Ship complete solutions. No workarounds when a real fix exists. Cutovers, not backwards compatibility.
`;
}

function renderTmuxSection(ctx: OrchestratorContext): string {
  const wsFlag = ctx.streamId ? ` --stream-id ${ctx.streamId}` : "";
  return `
## Sub-agents (tmux2)

Spawn Claude Code sub-agents through tmux2 when work is parallelizable. Define work to delegate and make investigation across different aspects parallelizable. Prompt them by stating the problem, not the solution. Pass instructions through; make them positive, positioned as if you are the user passing through a message to investigate or do. Tone should be positive, tight, succinct, clear, and not overly prescriptive. You may include your interpretation, spec paths, and constraints, but soften the language a little bit, avoid hard gating with negatives. Describe what's broken or what the user wants, name files or areas when already known, and state the constraints that matter ("might be good to use existing Groq client", "classifier interface shouldn't get modified as part of this, but if you need to tell me").

Launch sub-agents with \`--pi-session-id ${ctx.piSessionId}${wsFlag}\` so stop events route back to this stream and your pi-session.

// === HUMAN REVIEW LINE === ABOVE: FINAL === BELOW: EDITABLE ===
Sub-agents auto-notify on completion via stop events — so fire and forget instead of waiting. No polling or sleeping. On a stop event, if needed you may query the blackboard for session details, and read the transcript or tmux pane, then decide: notify the user, follow up on the same session through tmux2 \`message\`, or launch a fresh session when a new exploration is required — re-prompting isn't the goal when the direction has shifted. Reserve \`send\` for raw keystrokes: a bare Enter for permission prompts, or an Escape to cancel an inferring session and stop it in its tracks. Stop events from sessions you didn't prompt mean the user is interacting directly — read to stay in the loop, but don't act.
`;
}
