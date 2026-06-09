# Working-Directory Switcher

A live cwd switcher for orchestrator streams. The current working directory shown in the ChatPanel header is clickable: clicking it opens a directory picker rooted at the projects directory, lets the user drill into any folder, and committing a folder re-points the stream's pi session to that directory — immediately, with the conversation preserved — and persists the change so a restart resumes at the new cwd with no override hacks.

This applies to **orchestrator streams**, not the default agent (whose cwd is fixed at the projects directory).

## Where cwd lives

A stream's working directory is stored in `streams.repo_path`. When `create_stream` runs, `createStreamProgrammatic` resolves `effectiveCwd = input.cwd ?? config.projectsDir`, `enrichStream` writes it to `streams.repo_path` (`worktree_path` stays `NULL`), and `createOrchestrator` binds the pi session's cwd to that same path. `worktree_path` is independent and usually null — the switcher only re-points `repo_path` and does not touch worktree/merge state. (If a stream has a real git worktree, its repo_path/worktree_path are coupled by git; switching cwd elsewhere is out of scope.)

The cwd is reflected in four places that must stay in sync:

- `streams.repo_path` — canonical stream cwd (read by `resolveBaseCwd` for directory completions, by orchestrator activation, etc.)
- `pi_sessions.cwd` — the persisted pi session cwd
- The session JSONL **header** `cwd` field — what `SessionManager.open` reads on resume
- The live `AgentSessionRuntime` binding — tools, system prompt, skills, extension runner (all frozen at session construction)

## User Behavior

### Opening

The header path (currently rendered via `CopyableCode`) becomes a click target. Clicking it opens the directory picker with a literal `@` already present, rooted at the projects directory. Copy-to-clipboard moves to keyboard only: the `c` then `d` shortcut still copies the absolute path; clicking no longer copies.

### The picker

A `PathPicker` (the same component used by the message composer) anchored under the header, with a **top input** that behaves like the message composer's path-completion field but scoped to directories:

- The input holds a literal `@` prefix to anchor behavior identically to the composer (`@coded-programs/flitterbot/`). The text after `@` is the `query` sent to the backend.
- Typing filters; the list shows **directories only**.
- **Clicking a row** drills in: inserts `@.../` into the input and re-queries, listing that folder's children. A row click never commits.
- If a directory has no subdirectories, the list shows empty (no entries).
- The picker roots at the projects directory regardless of the stream's current cwd, and the user can navigate **above** the projects directory (via `../`, bounded at the home directory by the backend).

### Drill vs commit

- **Click a row** → drill in (insert `@.../`, list children). Never commits.
- **Enter** on a highlighted directory → drill in.
- **Enter** when the current drilled directory has no child directories → commit the path currently in the input as the new cwd.
- **Space then Enter** → commit the path currently in the input as the new cwd.
- **Right-arrow affordance** (single control visually inside the right edge of the top input) → commit the current input path. The real input reserves right-side padding so typed text never renders beneath the arrow.

Commit changes the stream's cwd; drill only navigates. Clicking outside the open picker blurs the active field and dismisses the picker without committing.

## Backend: directories-only listing

Reuses the existing `/api/directory-completions` route (`browser-directory-completions.ts`) and `listDirectoryCompletionItems`. The only change is a **directories-only** flag (query param) that drops file entries from the result — drilling is exactly the existing "insert `@foo/` → re-query with that filter → backend lists children of `foo`" mechanism (`handlePathSelect` + `listDirectoryCompletionItems`). No new search function.

Rooting at the projects directory: the picker calls completions **without** `streamId`, so `resolveBaseCwd` falls back to `config.projectsDir`. Navigating above projectsDir uses the existing `../` branch in `listDirectoryCompletionItems`, which permits upward traversal bounded by `isUnder(targetDir, os.homedir())`.

## Commit flow (live re-bind + persist)

The commit is driven by a new control-surface route → runtime method that performs, in order:

1. **Guard** — refuse if the orchestrator is busy (mid-turn); the switch happens while idle/`waiting_for_user`.
2. **Validate** — the target directory exists on disk (mirrors the SDK's `assertSessionCwdExists`; a missing dir is rejected with a clear error).
3. **Rewrite the session-file header cwd** — edit line 1 of the JSONL (`type:"session"` entry) to the new resolved absolute cwd. This makes the on-disk header the single source of truth so a later plain resume picks up the new cwd with no `cwdOverride` plumbing.
4. **Live re-bind via the SDK** — `runtime.switchSession(currentSessionFile)` with no override. `switchSession` opens the file (reading the freshly-rewritten header cwd) *before* tearing down the old session, re-invokes flitterbot's own runtime factory at the new cwd (rebuilding system prompt, tools, skills, extension runner), restores the model, and emits the proper `session_shutdown`/`session_start` extension events. The conversation replays intact.
5. **Re-subscribe** — `switchSession` swaps `runtime.session`, so the old subscription is detached and `subscribeToPiSession` is re-run against the new session (the SDK requires re-subscribing after replacement).
6. **SQLite sync** — `UPDATE streams SET repo_path = <newCwd>` and `UPDATE pi_sessions SET cwd = <newCwd>`.
7. **Cache** — `toolDisplayCache.invalidatePiSession(piSessionId)` so relative tool-path display rebinds to the new cwd.
8. **Broadcast** — `streams_changed` and `status_changed` over the WebSocket hub so the header and clients refresh.

### Why this split (SDK vs handrolled)

`switchSession` is composable with flitterbot's setup and needs no special storage — it operates on the `AgentSessionRuntime` already held in `managed.runtime` and re-runs the factory we supplied. It owns the hard part (teardown, factory re-run at the new cwd, model restore, extension lifecycle). The three things it does not own — header rewrite, SQLite sync, re-subscribe/cache — are handled around the call. This avoids a full handroll of the `activateOrchestrator` path while still keeping the SQLite store and JSONL header authoritative.

### Restart behavior

Because step 3 rewrites the on-disk header, `start()` → `rehydrateOrchestrator` → `activateOrchestrator` → `createFlitterbotAgent({ resumeSessionFile })` → `SessionManager.open(file)` reads the new cwd from the header directly. No resume-time override logic is needed.

## Files Involved

- `web/src/components/chat-panel.tsx` — header path becomes a click target opening the picker; copy demoted to the `c`/`d` shortcut.
- `web/src/components/path-picker.tsx` — reused; directories-only items, top input with `@` prefix, right-arrow commit affordance.
- `web/src/components/common/caret-picker-positioner.tsx` — reused for anchoring.
- `web/src/lib/queries.ts` / `web/src/lib/api.ts` — directory-completions call with the directories-only flag and no `streamId` (projects-dir root).
- `src/routes/browser-directory-completions.ts` — add directories-only filtering to `listDirectoryCompletionItems`.
- `src/routes/` — new commit route (`set-stream-cwd` or similar) → runtime method.
- `src/runtime.ts` — commit method orchestrating guard → header rewrite → `switchSession` → re-subscribe → SQLite sync → cache invalidate → broadcast.
- `src/streams/pi-session-manager.ts` — helper to re-bind a live orchestrator's cwd (mirrors `activateOrchestrator`'s subscribe/state wiring around `switchSession`).
- `src/blackboard/query-streams.ts` — `repo_path` update; `pi_sessions.cwd` update.
- Session JSONL header rewrite helper (read entries, replace `cwd` on the `type:"session"` entry, rewrite file) — done only while the session is dormant/idle.

## Key Contracts

- `streams.repo_path` is the canonical stream cwd; the switcher's commit updates it.
- The session-file header `cwd` is authoritative for resume; commit rewrites it so restart is override-free.
- cwd is immutable on a live `AgentSession`; changing it always means a runtime replacement (`switchSession`), never an in-place mutation.
- Commit only runs while the orchestrator is idle; the target directory must exist.
