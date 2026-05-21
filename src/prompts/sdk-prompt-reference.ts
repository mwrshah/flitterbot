/**
 * # SDK system-prompt reference (doc-only)
 *
 * This file is **not used at runtime**. It exists so anyone touching
 * `default-agent.ts` or `orchestrator.ts` can see the full final prompt their
 * string ends up inside, without spelunking through pi-coding-agent internals.
 *
 * ## What flitterbot does
 *
 * `createFlitterbotAgent` (src/streams/create-agent.ts) passes:
 *
 *   resourceLoaderOptions: {
 *     appendSystemPromptOverride: (base) => [...base, promptRef.value],
 *     agentsFilesOverride: (baseAgents) => [<~/.agents/AGENTS.md>, ...baseAgents],
 *   }
 *
 * It does **not** set `systemPromptOverride` / `customPrompt`. The SDK's default
 * body is kept verbatim; flitterbot's `buildDefaultAgentPrompt(...)` or
 * `buildOrchestratorPrompt(...)` output is *appended after it* via
 * `appendSystemPromptOverride`.
 *
 * ## Final prompt structure at runtime
 *
 *   [SDK default body — see SDK_DEFAULT_BODY_REFERENCE below]
 *   \n\n
 *   [appendSystemPrompt entries joined by "\n\n"]
 *     = flitterbot role prompt (`promptRef.value`)
 *   \n\n
 *   # Project Context
 *
 *   Project-specific instructions and guidelines:
 *
 *   ## <path>
 *
 *   <content>
 *     ...one block per context file, with ~/.agents/AGENTS.md prepended by
 *     `agentsFilesOverride`, then whatever the SDK walked up from cwd.
 *
 *   [Skills index]
 *     formatSkillsForPrompt(skills) — only when the `read` tool is selected
 *     (flitterbot always has `read`).
 *
 *   Current date: YYYY-MM-DD
 *   Current working directory: <cwd>
 *
 * Source: pi-coding-agent@0.74.0 `dist/core/system-prompt.js → buildSystemPrompt`.
 *
 * ## SDK default body (verbatim)
 *
 * The constant below is what the SDK emits for flitterbot's tool set (read,
 * bash, edit, write + flitterbot's custom tools). Tool snippets and guidelines
 * are pulled from each built-in tool's `promptSnippet` / `promptGuidelines`
 * fields (see pi-coding-agent `dist/core/tools/{read,bash,edit,write}.js`).
 *
 * Flitterbot's custom tools (`query_blackboard`, `create_stream`,
 * `enqueue_message`, `create_worktree`, `close_stream`) do **not** set
 * `promptSnippet`, so they are *not* listed in "Available tools" below — they
 * still reach the model via the normal tool-call API, just not via the prompt.
 *
 * The `{readmePath}`, `{docsPath}`, `{examplesPath}` placeholders resolve at
 * runtime to absolute paths inside the installed pi-coding-agent package.
 * `{cwd}` and `{date}` are the session cwd and today's date.
 */
export const SDK_DEFAULT_BODY_REFERENCE = `\
You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
- read: Read file contents
- bash: Execute bash commands (ls, grep, find, etc.)
- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call
- write: Create or overwrite files

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
- Use bash for file operations like ls, rg, find
- Use read to examine files instead of cat or sed.
- Use edit for precise changes (edits[].oldText must match exactly)
- When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls
- Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.
- Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.
- Use write only for new files or complete rewrites.
- Be concise in your responses
- Show file paths clearly when working with files

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: {readmePath}
- Additional docs: {docsPath}
- Examples: {examplesPath} (extensions, custom tools, SDK)
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)

<<< appendSystemPrompt joined with "\\n\\n" — flitterbot inserts buildDefaultAgentPrompt(...) or buildOrchestratorPrompt(...) here >>>

# Project Context

Project-specific instructions and guidelines:

## <agents-file-path>

<agents-file-content>
... one block per AGENTS.md (flitterbot prepends ~/.agents/AGENTS.md; SDK walks cwd → git-root) ...

<<< Skills index from formatSkillsForPrompt(skills) >>>

Current date: {date}
Current working directory: {cwd}
`;
