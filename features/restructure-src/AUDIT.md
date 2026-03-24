# Restructure src/ — Audit Report

Audited 2026-03-24 against actual codebase state.

## Matches

The restructure is largely complete. The following match the proposed structure:

- **`control-surface/` eliminated** — directory no longer exists; all contents promoted to peer domains
- **`pi/`** — all 8 proposed files present: `create-agent.ts`, `format-prompt.ts`, `history.ts`, `session-manager.ts`, `session-state.ts`, `subscribe.ts`, `turn-queue.ts`, `index.ts`
- **`classifier/`** — `classify.ts`, `groq-client.ts`, `index.ts` as proposed
- **`custom-tools/`** — `close-workstream.ts`, `create-worktree.ts`, `manage-session.ts`, `index.ts` as proposed
- **`routes/`** — all 12 proposed files present at `src/routes/` including `_shared.ts`
- **`transcript/`** — `reader.ts`, `transcript.ts`, `index.ts` as proposed
- **`ws/hub.ts`** — as proposed
- **`runtime.ts`** and **`server.ts`** — lifted to `src/` root as proposed
- **`config/load-config.ts`** — as proposed
- **`claude-sessions/`** — `send-message.ts`, `tmux.ts`, `index.ts` as proposed
- **`blackboard/` flattened** — `queries/` and `writers/` subdirectories eliminated; files use `query-*` / `write-*` prefix convention
- **`types/` removed** — directory no longer exists
- **`contracts/`**, **`prompts/`**, **`whatsapp/`** — preserved as proposed
- **Barrel exports** — `index.ts` present in: `classifier`, `claude-sessions`, `contracts`, `custom-tools`, `pi`, `prompts`, `routes`, `transcript`

## Divergences

| Area | Doc says | Actual |
|---|---|---|
| `blackboard/query-pi-sessions.ts` | Proposed as `query-pi-sessions.ts` | Exists as `pi-sessions.ts` (no `query-` prefix) |
| `blackboard/index.ts` | Implied by rule 5 (barrel exports per domain) | Missing — no barrel export |
| `ws/index.ts` | Implied by rule 5 | Missing — `ws/` has only `hub.ts`, no barrel |
| `config/index.ts` | Implied by rule 5 | Missing — `config/` has only `load-config.ts`, no barrel |

## Missing from Doc

Items present in the codebase but not captured in the proposed structure:

- **`blackboard/schema.sql`** — SQL schema file, not mentioned in restructure plan
- **`blackboard/pi-sessions.ts`** — exists but uses non-standard name (see Divergences)
- **`src/qrcode-terminal.d.ts`** — vendor type shim at src root (doc mentioned `.d.ts` files as a destination for vendor shims, but didn't list this specific file)
- **`contracts/` contents** — doc says "unchanged" but doesn't enumerate: `blackboard.ts`, `control-surface-api.ts`, `tmux-bridge.ts`, `transcript.ts`, `websocket.ts`, `whatsapp.ts`, `index.ts`
- **`prompts/` contents** — doc says "unchanged" but doesn't enumerate: `orchestrator.ts`, `default-agent.ts`, `classifier.ts`, `index.ts`
- **`whatsapp/` contents** — doc says "unchanged" but doesn't enumerate: `auth.ts`, `cli.ts`, `config.ts`, `daemon.ts`, `ipc.ts`, `paths.ts`, `process.ts`, `receive.ts`, `send.ts`

## Missing from Implementation

- **`blackboard/index.ts`** — barrel export not created (rule 5 violation)
- **`ws/index.ts`** — barrel export not created (though single-file folder; rule 9 suggests absorbing instead)
- **`config/index.ts`** — barrel export not created (single-file folder; rule 9 candidate)
- **`blackboard/query-pi-sessions.ts`** — file exists as `pi-sessions.ts`, not renamed to follow the `query-*` prefix convention (rule 6 violation)
