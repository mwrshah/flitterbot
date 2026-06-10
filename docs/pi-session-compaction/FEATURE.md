# Pi Session Compaction

## Problem

Flitterbot runs Pi default and orchestrator sessions for long-lived conversations. Those sessions need an on-demand way to compact active context without rewriting Pi session JSONL by hand or breaking stream/session records.

## Goals

- Users can run `/compact` from the web chat command picker or hover actions.
- The command compacts the current Pi session: default chat compacts the default session; stream chats compact the stream orchestrator session.
- HTTP callers can compact a Pi session by `piSessionId`.
- Dormant orchestrators are activated before compaction using their persisted `pi_sessions.session_file`.
- Compaction uses Pi's `AgentSession.compact()` runtime primitive and leaves JSONL ownership with Pi.

## Architecture

Pi compaction is append-only. Flitterbot resolves the target managed Pi session, ensures a runtime is active, calls `session.compact(customInstructions)`, updates managed state, and broadcasts `history_rewritten` with reason `compact` so browser history queries refresh.

Compaction applies to Pi's current session branch. If a session has been pruned through `navigateTree(entryId)`, Pi's active leaf is the pruned entry; `session.compact()` summarizes the current branch from root to that leaf and appends a compaction entry as the new leaf.

## Pseudocode Contracts and Call Graph

```ts
type CompactRequest = {
  piSessionId: string;
  customInstructions?: string;
};

type CompactResponse = {
  ok: true;
  piSessionId: string;
  messageCount: number;
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
};

type HistoryRewrittenWebSocketEvent = {
  type: "history_rewritten";
  piSessionId: string;
  reason: "prune" | "compact";
};
```

Production call graph:

```text
Web chat `/compact`
  → sendMessage(targetPiSessionId=current chat session)
    → ControlSurfaceRuntime.enqueue
      → resolveCompactTargetPiSessionId(metadata)
      → compactPiSession(piSessionId, customInstructions)
        → activateOrchestrator(...) when dormant
        → managed.runtime.session.compact(customInstructions)
        → managed.state.noteEvent(messageCount)
        → wsHub.broadcast(history_rewritten: compact)
        → web ws-query-bridge invalidates streams-history

HTTP POST /api/streams/compact
  → handleCompactPiSessionRoute
    → runtime.compactPiSession(piSessionId, customInstructions)
```

## Component Tree

```text
<ChatPanel>
├── inputHoverButtons
│   ├── default session: clear session, compact session
│   └── work stream: compact session, close stream actions
└── <MessageInput>
    └── command picker items from getInternalCommandsForScope
        └── /compact inserts a built-in command without model invocation
```

## Files

- `src/runtime.ts` — modify: handles `/compact`, resolves default/stream target sessions, calls Pi compaction, broadcasts history refresh.
- `src/routes/compact-pi-session.ts` — create: bearer-protected HTTP route for on-demand compaction.
- `src/server.ts` — modify: routes `POST /api/streams/compact`.
- `src/routes/index.ts` — modify: exports compact route handler.
- `src/contracts/control-surface-api.ts` — modify: documents the compact endpoint.
- `src/contracts/websocket.ts` — modify: extends `history_rewritten.reason` to include `compact`.
- `src/prompts/classifier.ts` — modify: keeps built-in compaction commands on the default agent when no explicit UI target exists.
- `src/prompts/classifier.test.ts` — modify: updates command-routing prompt assertion.
- `web/src/lib/api.ts` — modify: exposes `compactPiSession` client call.
- `web/src/lib/internal-commands.ts` — modify: adds `/compact` to built-in command picker items.
- `web/src/lib/types.ts` — modify: extends websocket event reason type.
- `web/src/components/chat-panel.tsx` — modify: adds compact hover actions outside generated UI primitives.
