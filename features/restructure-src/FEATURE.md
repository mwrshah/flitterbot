# Restructure src/

## Problem

The `src/` directory has excessive nesting (3+ levels via `control-surface/` mega-folder, `blackboard/queries/|writers/` sub-folders) and mixed organizational strategies (some by domain, some by layer). This makes navigation slow and imports verbose.

## Goals

- Max 2 levels of nesting from `src/`
- Organize by domain (bounded context), not by layer
- Flatten blackboard queries/writers with prefix convention
- Explode `control-surface/` into peer domains at `src/` root
- Clean import paths via barrel exports

## Structural Rules

Permanent principles for file organization in this repo:

1. **Max depth of 2** — `src/domain/file.ts` is the deepest path. No 3+ level nesting.
2. **Organize by domain, not by layer** — group by bounded context (`pi/`, `whatsapp/`, `blackboard/`) not by file type (`services/`, `types/`, `utils/`).
3. **Co-locate types with consumers** — types live in their domain folder or in `contracts/` for shared cross-domain types. No standalone `types/` folder.
4. **One file per concern** — no god `utils.ts` files. Each utility is its own module (`git.ts`, `shell.ts`).
5. **Barrel exports (`index.ts`) per domain folder** — controls public API surface. Enables clean imports like `import { x } from '@/pi'`.
6. **Prefix instead of nest** — when a folder would only contain categorized files, use prefixes instead (e.g., `query-sessions.ts`, `write-messages.ts` instead of `queries/sessions.ts`, `writers/messages.ts`).
7. **Single source of truth** — `contracts/` is SSOT for shared types. Domain logic lives in domain folders. Never duplicate for backwards compat.
8. **Dependency flow is inward** — `routes/server` -> domain modules -> `contracts`. Domain modules don't import from routes.
9. **Collapse single-file folders** — if a domain has only one file, absorb it into the nearest related domain.
10. **Routes stay flat** — one file per route handler, no URL-path mirroring unless there are 20+ routes with clear hierarchy.

## Proposed Restructure

### Current Structure

```
src/
├── blackboard/
│   ├── queries/    (health-flags, messages, pi-sessions, sessions, whatsapp, workstreams)
│   ├── writers/    (message-writer, pending-actions, pi-session-writer, whatsapp-writer)
│   ├── db.ts
│   └── migrate.ts
├── claude-sessions/
├── config/
├── contracts/
├── control-surface/
│   ├── pi/         (create-agent, format-prompt, history, session-manager, session-state, subscribe)
│   ├── queue/      (turn-queue)
│   ├── router/     (classify, groq-client)
│   ├── routes/     (12 route files)
│   ├── tools/      (close-workstream, create-worktree, manage-session)
│   ├── ws/         (hub)
│   ├── runtime.ts
│   ├── server.ts
│   ├── transcript-reader.ts
│   └── transcript.ts
├── prompts/
├── types/          (vendor shims only)
└── whatsapp/
```

### Proposed Structure

```
src/
├── blackboard/
│   ├── db.ts
│   ├── migrate.ts
│   ├── query-health-flags.ts
│   ├── query-messages.ts
│   ├── query-pi-sessions.ts
│   ├── query-sessions.ts
│   ├── query-whatsapp.ts
│   ├── query-workstreams.ts
│   ├── write-messages.ts
│   ├── write-pending-actions.ts
│   ├── write-pi-sessions.ts
│   ├── write-whatsapp.ts
│   └── index.ts
├── classifier/
│   ├── classify.ts
│   ├── groq-client.ts
│   └── index.ts
├── claude-sessions/
│   ├── send-message.ts
│   ├── tmux.ts
│   └── index.ts
├── contracts/          (unchanged — SSOT for shared types)
├── custom-tools/
│   ├── close-workstream.ts
│   ├── create-worktree.ts
│   ├── manage-session.ts
│   └── index.ts
├── pi/
│   ├── create-agent.ts
│   ├── format-prompt.ts
│   ├── history.ts
│   ├── session-manager.ts
│   ├── session-state.ts
│   ├── subscribe.ts
│   ├── turn-queue.ts
│   └── index.ts
├── prompts/            (unchanged)
├── routes/
│   ├── browser-pi.ts
│   ├── browser-sessions.ts
│   ├── browser-skills.ts
│   ├── browser-transcript.ts
│   ├── cron-tick.ts
│   ├── direct-session-message.ts
│   ├── hooks.ts
│   ├── message.ts
│   ├── runtime-whatsapp.ts
│   ├── status.ts
│   ├── stop.ts
│   ├── _shared.ts
│   └── index.ts
├── transcript/
│   ├── reader.ts
│   ├── transcript.ts
│   └── index.ts
├── whatsapp/           (unchanged)
├── ws/
│   └── hub.ts
├── config/
│   └── load-config.ts
├── runtime.ts
└── server.ts
```

### Change Table

| Current Path | New Path | Rationale |
|---|---|---|
| `control-surface/pi/` | `pi/` | Promote to peer domain at src root |
| `control-surface/queue/turn-queue.ts` | `pi/turn-queue.ts` | Absorb into pi — turn queue is pi-specific |
| `control-surface/router/` | `classifier/` | Promote to peer domain; "classifier" names the bounded context |
| `control-surface/tools/` | `custom-tools/` | Promote to peer domain; "custom-tools" avoids ambiguity with MCP tools |
| `control-surface/routes/` | `routes/` | Promote to src root; stays flat per rule 10 |
| `control-surface/ws/` | `ws/` | Promote to src root |
| `control-surface/transcript-reader.ts` | `transcript/reader.ts` | Group transcript concerns into one domain |
| `control-surface/transcript.ts` | `transcript/transcript.ts` | Group transcript concerns into one domain |
| `control-surface/runtime.ts` | `runtime.ts` | Lift to src root — central orchestration |
| `control-surface/server.ts` | `server.ts` | Lift to src root — thin HTTP wiring |
| `blackboard/queries/*.ts` | `blackboard/query-*.ts` | Flatten with prefix convention per rule 6 |
| `blackboard/writers/*.ts` | `blackboard/write-*.ts` | Flatten with prefix convention per rule 6 |
| `types/` | _(removed)_ | Vendor shims move to `contracts/` or root `.d.ts` files |
| `contracts/` | `contracts/` | Unchanged — SSOT for shared types |
| `prompts/` | `prompts/` | Unchanged |
| `whatsapp/` | `whatsapp/` | Unchanged |
