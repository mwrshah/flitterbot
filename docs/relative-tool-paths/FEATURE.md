# Relative Tool Paths

Render tool inputs with stream-relative paths in the web UI while preserving the original absolute tool arguments for execution, replay, debugging, and future actions.

## Problem

Tool calls often carry absolute paths:

```txt
/Users/munawarshah/Documents/coded-programs/flitterbot-worktrees/195-relative-tool-paths-doc/src/streams/pi-subscribe.ts
```

Absolute paths are noisy in the chat timeline. The user usually wants the path relative to the stream's active workspace. For stream worktrees, the worktree is the meaningful root even when the pi session `cwd` is deeper inside the worktree. For sessions without a matching worktree path, `cwd` is the fallback root.

The UI should show:

```txt
src/streams/pi-subscribe.ts
```

without mutating the canonical tool input.

## Goals

- Keep `args` canonical and unchanged everywhere they can be used for execution, replay, audit, debugging, or future actions.
- Add display-only tool args at the server boundary and ship them next to canonical `args`.
- Prefer the stream `worktree_path` when the displayed path is equal to or downstream of that worktree.
- Otherwise, prefer the pi session `cwd` when the displayed path is equal to or downstream of that cwd.
- Do not do per-tool-event SQLite lookups. Resolve context once per pi session and invalidate when the stream worktree changes.
- Avoid augmenting vendor `ToolCall` objects with private/underscore fields. Own the render shape in the web layer.
- Keep history routes and live WebSocket events consistent.

## Non-Goals

- Do not make the browser derive stream roots from session state. The server already owns `pi_sessions.cwd` and `streams.worktree_path`; duplicating that policy in clients makes history, live events, and future clients drift.
- Do not send shortened paths back into tools.
- Do not introduce a generic tool registry yet. The built-in tool/key map is bounded and sufficient.
- Do not rewrite tool result rendering or streaming architecture.

## Display Policy

Inputs are transformed only for presentation.

Whole-path tool args use policy-ordered roots, not longest-prefix ordering:

1. `streams.worktree_path`
2. `pi_sessions.cwd`

`bash.command` uses a stricter policy because command strings have shell semantics. Inside command text, only paths under `pi_sessions.cwd` are made cwd-relative; if that fails, paths under home are abbreviated to `~/...`; worktree-relative rewriting is not used in command strings because it can misrepresent what the command actually does.

Rules:

- Call the result a *display path*, not a relative path. It is relative only when a configured root matches; otherwise it may remain absolute or `~`-prefixed.
- If the value is neither absolute nor current-user-home-prefixed (`~` or `~/...`), leave it unchanged. Do not resolve relative paths against `cwd`; that creates hidden shell/path semantics and can make a clean relative arg longer.
- If the value is `~` or `~/...`, expand it to the current user's home directory for matching only. Never mutate canonical `args`.
- If the value equals the selected root, display `.`.
- If the value is downstream of the selected root, strip the root plus separator.
- If no worktree/cwd root matches but the value is inside the current user's home directory, display it as `~/...` instead of the full absolute path.
- If no root matches and the value is already `~`/`~/...`, keep the original `~` spelling.
- If no root or home match exists, leave the original display string unchanged.
- Use path-boundary matching, not string-prefix matching: `/repo/foo` must not match `/repo/foobar`.
- Normalize trailing slashes on roots before matching.
- Do not expand `~user/...`; it refers to another user's home and is shell/platform dependent.

Example when `cwd` is inside the worktree:

```txt
worktree_path = /repo-worktrees/195-relative-tool-paths-doc
cwd           = /repo-worktrees/195-relative-tool-paths-doc/src
path          = /repo-worktrees/195-relative-tool-paths-doc/src/streams/pi-subscribe.ts
```

Display relative to the worktree:

```txt
src/streams/pi-subscribe.ts
```

not relative to `cwd`:

```txt
streams/pi-subscribe.ts
```

## Architecture

```
Blackboard context
  pi_sessions.cwd + streams.worktree_path
        │
        ▼
ToolDisplayContextCache keyed by piSessionId
        │  invalidated on worktree_changed / create_worktree success
        ▼
ToolPathFormatter per pi session
        │
        ├─ live events: pi-subscribe.ts adds displayArgs to WS payloads
        └─ history route: browser-streams.ts enriches ChatTimelineTool items once before response
        ▼
Frontend timeline cache stores args + displayArgs
        ▼
Web render model uses displayArguments ?? arguments
```

The server is the single source of truth for display path policy. The frontend receives a render projection and does not need to know about stream worktrees or session cwd.

If no configured root matches, the display projection falls back only to home abbreviation: paths under the current user's home become `~/...`; paths outside home remain identical to the canonical path string. Do not fall back to basename, ellipsis truncation, or repo-root guessing; those make copy/debug context ambiguous.

## Backend Design

### Tool display module

Create `src/streams/tool-display.ts` with pure formatting plus a small blackboard-backed context cache.

Consequential interfaces:

```ts
export type ToolDisplayContext = {
  cwd?: string | null;
  worktreePath?: string | null;
  homeDir?: string | null;
};

export type ToolPathFormatter = {
  displayArgsForTool(toolName: string, args: unknown): JsonObject | undefined;
};

export type ToolDisplayContextCache = {
  formatterForPiSession(piSessionId: string): ToolPathFormatter;
  displayArgsForTool(piSessionId: string, toolName: string, args: unknown): JsonObject | undefined;
  invalidatePiSession(piSessionId: string): void;
  deletePiSession(piSessionId: string): void;
};
```

`displayArgsForTool()` returns `undefined` when nothing changes. That keeps WS/history payloads smaller and makes `displayArgs ?? args` the only UI rule.

`homeDir` defaults to `process.env.HOME` and is used only to match `~`/`~/...` display strings against `worktreePath`/`cwd`.

### Tool/key coverage

Apply path formatting only where the field is known to represent a path:

- `read`, `edit`, `write`: `path`, `file_path`, `filePath`
- `grep`: `path`
- `ls`: `path`, `directory`
- `glob`: `path`, `directory`, `pattern` only if the value starts with an absolute root
- `bash`: format absolute and `~/...` path substrings inside the `command` string against `cwd`, then home abbreviation only. Do not use `worktreePath` for bash command text. Do not parse or resolve relative command tokens.

Keep the map local to `tool-display.ts`. A registry is unnecessary until third-party tools need to declare display behavior.

### Live WebSocket path

In `src/streams/pi-subscribe.ts`, inject the display cache and use the cache accessor in the subscription. Do not run a SQL join from inside each tool event.

```ts
const displayArgs = toolDisplayCache.displayArgsForTool(session.sessionId, toolName, args);
```

The accessor does an O(1) map lookup on the hot path. It hits SQLite only on cache miss or after invalidation. This is better than capturing an immutable formatter for the full subscription, because a stream can gain a worktree while the pi session is still alive.

Use the cache accessor in:

- `message_end`: enrich extracted `toolCalls` with `displayArgs`.
- `tool_execution_start`: include `displayArgs` next to canonical `args`.

Do not add helper functions that hide new blackboard lookups. Formatting helpers may call the cache accessor; they must not call `getToolDisplayContextForPiSession()` directly.

### Cache maintenance

Maintain a process-local `Map<string, ToolPathFormatter>` keyed by `piSessionId`.

Lifecycle:

1. First format request for a `piSessionId`: query `pi_sessions LEFT JOIN streams`, build a formatter, store it in the map.
2. Subsequent tool events for that session: reuse the cached formatter via map lookup only.
3. Successful `create_worktree` / `update_worktree_path`: find the active pi session for the stream, call `toolDisplayCache.invalidatePiSession(piSessionId)`, then broadcast `worktree_changed`.
4. Next tool event or history request for that `piSessionId`: cache miss rebuilds from the updated `streams.worktree_path`.
5. Session end / close / manager removal: call `toolDisplayCache.deletePiSession(piSessionId)` so long-lived runtimes do not accumulate stale entries.

`runtime.ts` already broadcasts `worktree_changed` after `create_worktree` succeeds for the stream's active pi session. Use the same point to invalidate the backend display cache before the broadcast. If there is no active pi session for that stream, no live cache entry needs invalidation; the next history request for the pi session will build from the database.

The important invariant: creating or updating a stream worktree during an active pi session changes subsequent displayed tool paths without requiring process restart and without per-event SQLite work.

### History route

In `src/routes/browser-streams.ts`, do not enrich separately in the disk branch and the live-session branch. Read items first, then apply one tail-end enrichment pass before building the response:

```ts
let items = await read-or-load-items();
items = enrichTimelineToolDisplays(items, formatter);
```

For the not-in-memory disk fallback, do the same after `readStreamsHistory()` succeeds and before `sendJson()`.

## Contracts

Extend shared contracts with display-only fields:

- `ChatTimelineTool.displayArgs?: JsonValue`
- `MessageEndWebSocketEvent.toolCalls[].displayArgs?: unknown`
- `ToolExecutionStartWebSocketEvent.displayArgs?: unknown`
- frontend `WsMessage` equivalents

Document the invariant in comments:

- `args` is canonical tool input.
- `displayArgs` is UI-only and must never be sent back to tools.

## Frontend Design

### Timeline cache

`web/src/lib/ws-query-bridge.ts` should persist both canonical and display args when converting `message_end.toolCalls` into `ChatTimelineTool` start items:

```ts
args: tc.args,
displayArgs: tc.displayArgs,
```

`tool_execution_start.displayArgs` is only live progress metadata. The durable tool start still comes from `message_end.toolCalls`.

### Render model

Do not cast vendor `ToolCall` to add `_displayArguments`.

Own a local web render type in one place, preferably `web/src/lib/pi-web-ui-bridge.ts` or a small adjacent module:

```ts
export type RenderableToolCall = ToolCall & {
  displayArguments?: Record<string, unknown>;
};
```

The bridge constructs renderable tool calls from timeline items:

```ts
{
  type: "toolCall",
  id: item.toolUseId,
  name: item.tool,
  arguments: item.args ?? {},
  displayArguments: item.displayArgs ?? undefined,
}
```

`web/src/pi-web-ui/chat-components.ts` consumes `displayArguments ?? arguments` directly. The canonical `arguments` remains available for any action path that needs raw values.

If the vendor `AssistantMessage["content"]` type makes this awkward, define the local render message type used by Flitterbot's Lit components instead of pretending the content is exactly the vendor shape. The component is application-owned, so it can use the application render contract.

## Files

- `docs/relative-tool-paths/FEATURE.md` (create) — feature architecture and implementation plan.
- `src/streams/tool-display.ts` (create) — display context lookup/cache, path formatter, tool/key map, timeline enrichment helper.
- `src/streams/pi-subscribe.ts` (modify) — reuse a per-session formatter for `message_end.toolCalls` and `tool_execution_start`.
- `src/routes/browser-streams.ts` (modify) — apply one tail-end history enrichment pass for live and disk session history.
- `src/runtime.ts` (modify) — invalidate display context cache on successful `create_worktree` / `worktree_changed` path.
- `src/contracts/timeline.ts` (modify) — add `ChatTimelineTool.displayArgs` with canonical-vs-display invariant.
- `src/contracts/websocket.ts` (modify) — add WS display args for tool calls and tool execution start.
- `web/src/lib/types.ts` (modify) — mirror WS display args on the frontend union.
- `web/src/lib/ws-query-bridge.ts` (modify) — store `displayArgs` on timeline tool items from `message_end.toolCalls`.
- `web/src/lib/pi-web-ui-bridge.ts` (modify) — construct an owned renderable tool-call shape with `displayArguments`.
- `web/src/pi-web-ui/chat-components.ts` (modify) — render `displayArguments ?? arguments` without mutating or augmenting vendor `ToolCall`.
- `src/streams/tool-display.test.ts` (create) — formatter and cache invalidation behavior.
- `web/src/lib/pi-web-ui-bridge.test.ts` or existing equivalent (modify/create) — verifies renderable tool calls preserve canonical args and expose display args.

## Test Plan

Backend formatter tests:

- Worktree root wins over deeper cwd for whole-path tool args.
- Cwd is used when no worktree matches for whole-path tool args.
- Bash command text uses cwd first, then home abbreviation, and never rewrites against worktree.
- Non-matching absolute paths under the current user's home display as `~/...`.
- Non-matching absolute paths outside home stay absolute.
- Relative paths stay unchanged, including relative strings that happen to contain the worktree directory name.
- `~` and `~/...` expand for matching only, then display relative when they fall under worktree/cwd.
- Non-matching `~` paths keep their original `~` spelling.
- `~user/...` stays unchanged.
- Root equality renders `.`.
- Path-boundary matching does not collapse `/repo/foobar` under `/repo/foo`.
- Bash command display replaces matching absolute roots and conservative `~/...` tokens without changing canonical args.
- `displayArgsForTool()` returns `undefined` when no fields change.

Cache tests:

- Repeated formatter access for the same `piSessionId` performs one DB lookup.
- Invalidation causes the next access to read updated `worktree_path`.

Contract/bridge tests:

- `message_end.toolCalls[].args` remains canonical while `displayArgs` is persisted on `ChatTimelineTool`.
- `timelineToAgentMessages()` emits renderable tool calls with raw `arguments` and optional `displayArguments`.
- Tool rendering uses display args for summaries and details.

Manual checks:

- A stream with a worktree shows tool paths relative to the worktree.
- A session without a worktree shows paths relative to its cwd when matched.
- Creating a worktree mid-session changes subsequent displayed paths after the `worktree_changed` event.
- Reloading the browser/history route shows the same display paths as live events.

## Acceptance Criteria

- Tool UI displays shortened paths according to the worktree-first policy.
- Canonical `args` are unchanged in timeline items, WS payloads, session history parsing, and tool action paths.
- Live tool events do not query SQLite per event.
- No `_displayArguments` or other private-field augmentation is added to vendor `ToolCall` objects.
- History enrichment is centralized rather than duplicated across route branches.
- Tests cover path precedence, boundary matching, unchanged payload discipline, and cache invalidation.
