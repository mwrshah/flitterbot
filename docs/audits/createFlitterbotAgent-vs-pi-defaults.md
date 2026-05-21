# `createFlitterbotAgent` vs pi-sdk defaults

Audit target: `export async function createFlitterbotAgent` in `src/streams/create-agent.ts`.
Reference SDK: `@earendil-works/pi-coding-agent@0.74.0` (resolved under `node_modules/.pnpm/...`).

---

## 1. Extension shape — how does this compare to the pi-sdk's idiomatic factory?

### What the SDK considers idiomatic

The SDK exposes two factory tiers (see `docs/sdk.md`):

- **One-shot:** `createAgentSession({...})` — single session, no replacement.
- **Runtime tier:** `createAgentSessionRuntime(factory, init)` — for `newSession()` / `switchSession()` / `fork()` / `importFromJsonl()`. The factory closes over process-global inputs and returns the trio `{ session, services, diagnostics }` built via `createAgentSessionServices(...) → createAgentSessionFromServices(...)`.

The SDK's notion of "extension" is separate from the factory: extensions are TypeScript modules under `~/.pi/agent/extensions/*.ts` or `.pi/extensions/*.ts` (auto-discovered by `DefaultResourceLoader`) or supplied programmatically via `extensionFactories: [(pi) => { ... }]`. They get an `ExtensionAPI` and can subscribe to events (`pi.on(...)`), register tools (`pi.registerTool(...)`), register commands (`pi.registerCommand(...)`), etc. See `docs/extensions.md`.

The SDK also accepts plain tool arrays directly: `customTools: [defineTool(...)]`. These are merged with whatever the extensions register.

### What `createFlitterbotAgent` actually does

`createFlitterbotAgent` (`src/streams/create-agent.ts:64`) is a **wrapper around the runtime tier**, not an extension. It builds a `CreateAgentSessionRuntimeFactory` and hands it to `createAgentSessionRuntime`. The factory body composes `createAgentSessionServices` → `createAgentSessionFromServices` exactly like the example in `docs/sdk.md`.

It is **not** authored as a pi extension. Across the entire flitterbot tree:

```
$ rg -n "ExtensionAPI|extensionFactories|additionalExtensionPaths|registerCommand|registerTool|pi\.on\(" src/
(no matches)
```

So none of the pi extension surface (`pi.on`, `pi.registerTool`, `pi.registerCommand`, `pi.registerShortcut`, the event bus, the `/reload` hot-reload pathway) is used. Flitterbot owns the session lifecycle directly.

### Concrete additions layered on the SDK runtime

| Addition | Where | What it does |
|---|---|---|
| Role-scoped custom tools | `src/runtime.ts:1364` `createCustomTools(role, streamId)` | Builds `customTools[]` per role. Default session gets `query_blackboard`, `create_stream`, `enqueue_message`. Orchestrator gets `query_blackboard`, `create_worktree`, `close_stream`. Passed via `customTools` option of `createAgentSessionFromServices`. |
| Custom `agentDir` | `create-agent.ts:91` | `agentDir = config.controlSurfaceAgentDir` (~/.flitterbot/control-surface/agent), not `~/.pi/agent`. Side effect: SDK extension discovery from `<agentDir>/extensions/` resolves to the flitterbot dir, so any user extensions under `~/.pi/agent/extensions/` are silently invisible. |
| Custom auth/model paths | `src/pi-auth.ts:13-38` | `createPiAuthStorage` / `createPiModelRegistry` still resolve to `~/.pi/agent/{auth.json,models.json}` when present, falling back to the flitterbot agent dir. So auth/models stay shared with the pi CLI, but skills/AGENTS.md/extensions/settings are isolated. |
| Skill path stack | `create-agent.ts:93-122` | `additionalSkillPaths` precedence: bundled `~/.flitterbot/skills` → `~/.claude/skills` → `~/.agents/skills` → `config.extraSkillPaths`. De-duped by name (first wins). Collisions surfaced via `resourceLoader.getSkills().diagnostics`. |
| Forced `~/.agents/AGENTS.md` injection | `create-agent.ts:127-145, 191-204` | The SDK's `DefaultResourceLoader` walks AGENTS.md up from cwd to git root only. Flitterbot prepends `~/.agents/AGENTS.md` to `contextFiles` via `agentsFilesOverride`, regardless of cwd. Path-deduped against the SDK's own walk. |
| In-memory settings + transport | `create-agent.ts:92, 105-106` | `SettingsManager.inMemory()` then `setTransport(config.piTransport)`. No `settings.json` files consulted. |
| Resume support | `create-agent.ts:80-83, 150-153` | `resumeSessionFile` opens an existing JSONL via `SessionManager.open(...)` so `piSessionId` and history survive restarts. When resuming without an explicit `modelId`, lets the SDK restore the model from the session's `model_change` history. |
| Per-agent `promptRef` | `create-agent.ts:85-89, 162-170` | Mutable closure refreshed on every factory invocation (i.e. each `newSession()`) so the freshly-minted `piSessionId` interpolated into the prompt stays correct. Per-agent state, not a shared file — comment explicitly cites a concurrent-orchestrator race fix. |
| Two roles in one factory | `create-agent.ts:39, 263-281` | `role: "default" \| "orchestrator"` switches the appended prompt body and the tool set the caller supplies. |
| External event subscription | `src/streams/pi-subscribe.ts:251` `subscribeToPiSession` | Hand-rolled consumer of `session.subscribe(...)` that translates SDK events into flitterbot WebSocket payloads (`text_delta`, `thinking_delta`, `tool_execution_*`, `message_end`, `stream_surfaced`, `agent_end`) and writes to the blackboard. Mints a transient `streaming-<n>` correlation key during streaming and swaps to `sessionManager.getLeafId()` (canonical entry id) after `message_end` lands. |
| Per-agent turn queue | `src/streams/pi-session-manager.ts:545-595` `TurnQueue` | Serialises inbound messages per session, broadcasts `queue_item_start`/`queue_item_end` on the WS hub, and triggers `destroyOrchestrator(...)` on crashes. Sits in front of `session.prompt()`. |
| Multi-agent lifecycle + dormancy | `src/streams/pi-session-manager.ts:104-303` `PiSessionManager` | One default + one orchestrator per open stream. Adds `rehydrateOrchestrator` (no live SDK until first message), `activateOrchestrator` (lazy resume from JSONL), `destroyOrchestrator`, `resetDefault` (wraps `runtime.newSession()` + DB upsert + re-subscribe). Source of `pi_sessions` blackboard rows. |
| Model resolution via `getModel` | `create-agent.ts:147-160, 230-241` | Bypasses `modelRegistry.find()` for selection — uses `resolveModelEntry(config, modelId)` against the flitterbot config and re-derives the canonical entry id from `runtime.session.model` after construction. |

What is **not** there: no `pi.on("tool_call", ...)` permission gates, no `registerCommand("/foo")`, no `registerShortcut`, no extension hot-reload, no event-bus cross-extension messaging, no `pi.appendEntry()` for session-state persistence (the blackboard SQLite replaces that), no custom UI / TUI components.

---

## 2. System prompt handling

### SDK assembly (reference)

`dist/core/system-prompt.js → buildSystemPrompt(opts)` is the only place the prompt is built. Two branches:

- If `customPrompt` is set → it replaces the SDK's default body entirely. Then appends `appendSystemPrompt`, `# Project Context` (context files), skills index (when `read` is available), and `Current date` / `Current working directory`.
- Otherwise → emits the stock body that starts with `You are an expert coding assistant operating inside pi, a coding agent harness...`, followed by `Available tools`, `Guidelines`, the `Pi documentation` paragraph, then the same trailing sections (append → context → skills → date → cwd).

`ResourceLoader` exposes two relevant hooks: `systemPromptOverride: (base) => string | undefined` (sets `customPrompt`, fully supersedes) and `appendSystemPromptOverride: (base: string[]) => string[]` (rewrites the `appendSystemPrompt` array, which is joined with `\n\n` and concatenated *after* the SDK body).

### What flitterbot does

Flitterbot **keeps the SDK default body** and **appends** its own instructions:

```ts
// create-agent.ts:177-189
resourceLoaderOptions: {
  additionalSkillPaths,
  appendSystemPromptOverride: (base) => [...base, promptRef.value],
  agentsFilesOverride: (baseAgents) => { ... prepend ~/.agents/AGENTS.md ... },
},
```

There is no `systemPromptOverride` and no `customPrompt`. Verified by:

```
$ rg -n "systemPromptOverride|customPrompt" src/
(no matches)
```

`promptRef.value` is produced by `resolveSystemPrompt(role, piSessionId, cwd, ctx, projectsDir, tmuxEnabled)` at `create-agent.ts:265-281`:

- `role === "orchestrator"` → `buildOrchestratorPrompt(ctx, { tmux })` from `src/prompts/orchestrator.ts` (`# Flitterbot Orchestrator Instructions`).
- otherwise → `buildDefaultAgentPrompt(piSessionId, projectsDir)` from `src/prompts/default-agent.ts` (`# Flitterbot Default Agent Instructions`).

Both are pure TS string builders. The on-disk file `~/.flitterbot/control-surface/agent/system-prompt.md` is **stale** — not read by anything in `src/`. Safe to delete.

### Final runtime prompt structure

```
[SDK default body]
  You are an expert coding assistant operating inside pi, a coding agent harness...
  Available tools:  read, bash, edit, write (+ snippets)
  Guidelines:       (the standard pi list)
  Pi documentation: (paths to README, docs, examples — read-when-asked guidance)

\n\n
[Flitterbot role prompt — `promptRef.value`]
  # Flitterbot {Default Agent | Orchestrator} Instructions
  ... runtime self-awareness, rules, boundaries, style ...
  (orchestrator-only: optional Sub-agents (tmux) section)

\n\n
# Project Context
## /Users/.../.agents/AGENTS.md   ← prepended by `agentsFilesOverride`
<content>

## <project AGENTS.md if walked up from cwd>
<content>

[Skills index]   ← formatSkillsForPrompt(skills), since `read` is in the tool set
...

Current date: YYYY-MM-DD
Current working directory: <cwd>
```

The role prompt is **purely additive**. Anything in the SDK default body — the "expert coding assistant inside pi" identity framing, the pi-docs paragraph, the SDK's own guidelines list — is still in front of every flitterbot agent.

---

## Notable divergences / patterns worth reconsidering

- **No pi-extension pattern, anywhere.** All event handling, tool registration, and lifecycle hooks are done directly via the SDK's programmatic options (`customTools`, `session.subscribe(...)`). That's a deliberate architectural choice and works fine for a single-process server, but it means: no `/reload` hot-reload for tools, no per-tool extension contexts, no use of `pi.on("tool_call")` to gate destructive operations (which would be a natural fit for `close_stream` / `bash` safety), no shared event bus across modules. Worth a look if user-pluggable behavior ever becomes a requirement.
- **SDK default prompt is preserved, not replaced.** The agent identity at the top of every system prompt is still "expert coding assistant operating inside pi" plus the pi-documentation paragraph. The flitterbot orchestrator personality is appended *underneath* that. If the intent is a clean "orchestrator-only" framing, `systemPromptOverride: () => buildOrchestratorPrompt(...)` would be more honest; today both framings coexist and the model has to pick. Recency means the later text usually wins, but the pi framing leaks.
- **`agentDir` isolation cuts off `~/.pi/agent/extensions/`.** `controlSurfaceAgentDir` points at `~/.flitterbot/control-surface/agent/`, so the SDK's global-extension scan can't see anything a user has installed under `~/.pi/agent/extensions/`. Auth/models still resolve from `~/.pi/agent/` via the fallback in `src/pi-auth.ts`, so this is asymmetric. Either intentional (sandboxing) or oversight — worth pinning down.
- **`~/.agents/AGENTS.md` is forced in via `agentsFilesOverride`** because the SDK's AGENTS.md walk only goes up to git root, not `$HOME`. The path-based dedup is correct. Without this injection, user-level rules would silently vanish for any non-repo cwd.
- **Mutable `promptRef` closure** is the right shape for `newSession()` rebuilds: each call to the factory re-derives the prompt with the new `piSessionId`. The comment correctly notes the per-agent ref prevents concurrent orchestrators from corrupting each other's prompts.
- **Stale `~/.flitterbot/control-surface/agent/system-prompt.md`** on disk (10 KB) is unused by any code path. Either remove it or wire `systemPromptOverride` to read it — pick one.
- **`customTools: unknown[]` typing.** The caller (`runtime.ts:createCustomTools`) produces a `CustomToolDefinition[]` with raw JSON-Schema `parameters` (not TypeBox `TSchema`), and `createFlitterbotAgent` casts to `ToolDefinition[]` at the SDK boundary (`create-agent.ts:211`). Functions fine, but loses compile-time checking on tool params. The SDK's `defineTool({ parameters: Type.Object({...}) })` would restore inference; the cost is rewriting the four tools in TypeBox.
- **`PiSessionManager` is doing what the SDK's `AgentSessionRuntime` is designed for — partially.** It correctly delegates `newSession()` to the SDK runtime (in `resetDefault`), but rolls its own `destroyOrchestrator` / `activateOrchestrator` / dormancy semantics on top because the SDK has no concept of "many independent agents in one process". This is a legitimate extension; just worth noting that the multi-agent supervisor is flitterbot-specific and the SDK won't help maintain it.

---

## TL;DR

`createFlitterbotAgent` is a thin, idiomatic wrapper around the SDK's three-call runtime form (`services → from-services → runtime`). The "extension-like" customizations it layers on are: (a) role-scoped `customTools`, (b) skill path stack, (c) forced `~/.agents/AGENTS.md` injection, (d) an appended role-specific prompt body, and (e) an isolated `controlSurfaceAgentDir`. The SDK default system prompt is kept and the flitterbot prompt is appended after it via `appendSystemPromptOverride` — not replaced. Flitterbot does not use the pi-sdk *extension* mechanism (`pi.on / registerTool / registerCommand`) at all; event handling and tool wiring go through SDK options and a hand-rolled `subscribeToPiSession`.
