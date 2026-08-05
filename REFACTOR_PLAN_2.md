# Refactor Plan 2 — Canonical Data Flows

## Objective

Reduce indirection by tracing runtime values end to end, retaining one authoritative contract until shape or invariant changes, adapting external data once, and deleting superseded aliases, wrappers, DTOs, and repeated projections. Rank work by duplicated runtime shape, transformation count, removable code, path frequency, and regression risk—not file size.

Current implementation is authoritative. `docs/` and `features/` informed this catalogue but may be stale; this plan does not modify protected feature docs.

## Selection method

For each flow, inspect:

```text
source/storage/SDK → generation → transport → cache/state → render/action
```

At each edge, ask: runtime shape, owner, invariant, source mutability, and available library primitive. A boundary earns a new type only when fields, semantics, ownership, validation, or lifecycle change.

## Feature and golden-path catalogue

### Messaging and agent execution

1. **Web user message → Pi turn → streamed browser result → final surfacing**
   - Path: `MessageInput`/`Surface` → route context `sendMessage` → `createSendMessage` → `FlitterbotWsClient.sendMessage` → `WebSocketHub` → `ControlSurfaceRuntime.handleWebSocketMessage` → classification/explicit target → `runtime.enqueue` → `TurnQueue` → `processQueueItem` → Pi `AgentSession.prompt` → `AgentSessionEvent` subscription → websocket server events → `ws-query-bridge` → conversation snapshots and TanStack Query → `ChatPanel`/React virtual rows; final assistant text → blackboard + WhatsApp + `stream_surfaced`.
   - Runtime identities: browser command, `QueueItem`, Pi SDK messages/events, websocket events, and canonical `ChatTimelineItem` render data.
   - Legitimate changes: external browser command → queue item; SDK event/message → transport-safe timeline/event.
   - Current excess: pass-through `createSendMessage`; local `SendMessageFn`; handwritten browser `WsMessage` duplicate of the shared websocket union; handwritten `PiSessionSubscriptionEvent` duplicate of SDK `AgentSessionEvent`; `SubscribablePiSession` projection of SDK `AgentSession`; record-built client events; payload aliases and casts around already typed events.

2. **WhatsApp inbound → classification → Pi turn → WhatsApp/web response**
   - Path: Baileys event → unwrap/extract/reject/dedup in `whatsapp/receive.ts` → control-surface HTTP `/message` → route classification → `runtime.enqueue` → same queue/Pi path → outbound persistence → daemon IPC → Baileys send; web receives `stream_surfaced`.
   - Legitimate changes: Baileys-owned message → accepted text/metadata at external boundary; HTTP request → `QueueItem`; final Pi message → channel-formatted text.
   - Review targets: `MessageRequest` versus `EnqueueInput`; repeated source/metadata shaping; daemon request/response aliases; mirrored outbound formatting.

3. **HTTP web/API message → classification → Pi queue**
   - Path: `POST /message` → `readJsonBody<MessageRequest>` → source/delivery normalization → `routeMessage` → metadata wrapper → `runtime.enqueue`.
   - Excess: websocket and HTTP implement parallel classification and enqueue preparation; `formatInboundMessage` is identity; route result wraps only `{ metadata }`; image types repeat.

4. **Direct message to workstream orchestrator**
   - Path: `enqueue_message` custom tool → stream lookup → managed orchestrator activation → queue enqueue → Pi prompt/events.
   - Review targets: tool result DTOs, routing metadata copied only to recover stream identity, queue-depth wrappers.

5. **Direct message to managed Claude Code/tmux session**
   - Path: web downstream panel → direct-session route → `sendMessageToAgentSession` → tmux UI inspection → literal send/Enter → delivery result → response DTO → UI mutation state.
   - Legitimate change: API command → tmux operation/result.
   - Excess: imported result renames, response/failure unions copying tmux result semantics, inspection snapshots transformed before one consumer.

6. **Pi SDK event → websocket → browser state**
   - Path: `AgentSessionEvent` → `pi-subscribe.ts` → `ControlSurfaceWebSocketServerEvent` → `WebSocketHub.broadcast` → JSON → browser websocket client → query bridge → one of localized conversation snapshots, canonical timeline cache, status invalidation, or toast.
   - Excess: SDK event union copied locally; shared server-event union copied again as `WsMessage`; event payloads retain both selected fields and raw `event`; transport fields use `unknown` where `JsonValue`/SDK fields already own shape; no-op `toolcall_start`; one-call broadcast wrapper.

7. **Assistant message commit and tool lifecycle**
   - Path: SDK `message_end` → `extractMessageBlocks` → ordered `ChatTimelineMessage.blocks` with tool references plus `ChatTimelineTool[]` → conversation-state cache commit; tool execution events → keyed transient tool snapshot; SDK tool-result message → `toolResultMessageToTimelineItem` → canonical end item → cache → `buildConversationRows` pairs start/end by `toolUseId` for direct React rendering.
   - Legitimate changes: SDK provider message → app timeline at the server boundary.
   - Remaining review target: history parsing and live subscription still parse SDK message content in separate functions.

8. **Agent history reload/pagination → browser cache → render**
   - Path: Pi `SessionManager` branch/JSONL → `entriesToTimeline` → history route/page → `StreamsHistoryResponse` → TanStack infinite query → flat timeline → `buildConversationRows` → TanStack Virtual React rows.
   - Legitimate changes: persisted SDK entries → timeline; query pages remain TanStack-owned; row grouping preserves the timeline contract.
   - Remaining review targets: live and persisted paths parse SDK content separately; cursor/page response optionality.

9. **Input Surface unified timeline**
   - Path: blackboard messages/history APIs + `message_ack` optimistic user entry + `stream_surfaced` final entries → `surface-timeline` query → `timelineToEntries` → rows.
   - Excess: agent timeline type used for a distinct blackboard feed then projected again to `SurfaceEntry`; three dedup rules (ID, server ID, role+content); stream identity duplicated inside event and message.

10. **Queueing, steer/follow-up, and coalescing**
    - Path: inbound command → `EnqueueInput` → `QueueItem` → coalescing → `TurnQueue` → Pi `prompt(...streamingBehavior)`.
    - Excess: `QueueSource = MessageSource`; images reshaped before queue though Pi image content is available; IDs migrate between top-level fields and metadata; external queue duplicates Pi SDK steer/follow-up queue behavior and should be reviewed by invariant before consolidation.

### Stream and session lifecycle

11. **Default Pi startup and open-stream rehydration**
    - Path: runtime start → blackboard reconciliation → `createFlitterbotAgent`/dormant managed session → model/resource load → `ManagedPiSession` maps → lazy activation → SDK subscription.
    - Review targets: `ManagedPiSession` mirrors SDK runtime/session fields; model info projection; default/workstream creation paths.

12. **Create stream → orchestrator bootstrap**
    - Path: custom `create_stream` tool/programmatic request → name collision resolution → stream insert → Pi session spawn → optional context relevance classification → initial queue item → websocket status events.
    - Excess: success/failure unions carry overlapping stream fields; bootstrap queue items are built in separate normal/batch branches; dynamic imports and repeated broadcast/persist blocks.

13. **Fork stream/session**
    - Path: UI/internal command → runtime fork → Pi session tree fork → stream row/session creation → worktree metadata → websocket events → navigation/status refresh.
    - Review targets: source session/stream identity repeatedly resolved and projected; fork result wrappers.

14. **Close stream → commit/merge/push → agent destruction**
    - Path: `close_stream` tool → preview/confirmation → git status/diff/log → optional commit → base worktree merge/push → blackboard close → pending Pi destruction after `agent_end` → UI status events.
    - Legitimate changes: tool request → validated git operation plan/result.
    - Excess: custom-tool and runtime close result contracts; repeated stream lookup and status broadcasts; git command wrappers with one caller.

15. **Reopen/recover stream**
    - Path: sidebar mutation → route → blackboard reopen or dead-session recovery → worktree reconciliation → Pi session spawn/rehydration → status events → route recovery.
    - Review targets: `StreamRecoveryKind` duplicates derivable status conditions; several status snapshots drive one action.

16. **Switch stream cwd/worktree association**
    - Path: path picker/API → validation → stream row update → managed session replacement/rebind → worktree/status events → query invalidation.
    - Review targets: cwd/repo/worktree path aliases and repeated lookup; event pair carrying the same invalidation cause.

17. **Pi session model/thinking selection**
    - Path: model selector → API mutation → registry resolution/auth check → SDK session setter → blackboard mirror → status cache update.
    - Excess: model identity appears as entry ID, provider/model ID, SDK model, and UI item; cache update rebuilds response projections.

18. **Compaction, prune, and history rewrite**
    - Path: internal command/API → Pi compact or session-tree rewrite → persisted session update → `history_rewritten` → query invalidation/refetch.
    - Review targets: command target resolution shared with fork; compact/prune response wrappers; lifecycle events declared but not surfaced.

### Claude Code feedback and operational flows

19. **Claude hook feedback loop**
    - Path: installed hook script → `/hook/:event` → payload normalization → session register/idle/end writes → owner Pi resolution → queue item → orchestrator turn → `sessions_changed`.
    - Excess: route event names and hook names duplicate casing variants; payload is repeatedly treated as records; session ownership fallback logic crosses runtime and blackboard forms.

20. **Downstream Claude session discovery/status/transcript**
    - Path: blackboard session rows → list/detail routes → control-surface DTOs → TanStack Query → downstream panel; transcript path → normalized transcript page → UI.
    - Excess: row-to-list mapping repeated across queries; duplicate `RawTranscriptEntry`; aliases around session list items; transcript has a second generic normalization model separate from Pi history.

21. **Cron tick and maintenance health gates**
    - Path: scheduler POST → route gates → stale/idle prompt enqueue; runtime interval → DB ping/WhatsApp refresh/stale detection/tmux cleanup/stuck-turn flag → alerts/status.
    - Review targets: `CountRow` defined three times; health/status wrappers; gate results carry parallel action/reason fields.

### State, configuration, and integrations

22. **Blackboard write/read contracts**
    - Path: runtime/domain input → prepared SQLite statement → row → contract → route/runtime projection.
    - Excess: `BlackboardDatabase` generic casts plus per-module `SqlDatabase` picks; duplicated `CountRow`; `pi-sessions.ts` adapts almost every operation to `write-pi-sessions.ts`; row and API DTO optionality drift.

23. **Status snapshot → browser navigation/sidebar/runtime health**
    - Path: runtime + blackboard + WhatsApp status → `StatusResponse` → query → sidebar/routes/health indicator.
    - Excess: large runtime projection maps stream rows twice for open/closed; `OfflineStatus` is a second broad status shape; repeated component-level selects.

24. **WhatsApp daemon control/auth/IPC**
    - Path: settings/runtime action → process manager → Unix socket command → daemon/Baileys → daemon response → control-surface response → UI.
    - Excess: daemon runtime status renamed at imports; control-surface status derived via another contract; IPC JSON parsed directly into asserted types; path helpers are one-line wrappers but encode ownership.

25. **Provider authentication**
    - Path: settings UI → auth route → `ProviderAuthManager` flow → Pi model runtime/auth event stream → polling/snapshot → UI.
    - Review targets: auth prompt omits/re-adds ID; flow state and snapshot duplicate most fields; pending prompt wrapper; route pass-through DTOs.

26. **Model/config load and persistence**
    - Path: JSON/env → raw config assertions/normalizers → `FlitterbotConfig` → model registry/runtime; UI config mutations → persisted models/config → runtime reload.
    - Legitimate change: untrusted JSON → validated config once.
    - Excess: assertion-led parsing and defaults spread across helpers; model shapes overlap SDK and control-surface contracts.

27. **Directory autocomplete/file finder**
    - Path: composer `@` query → TanStack query → API route validation/root resolution → `FileFinder` cache/search → completion response → picker insertion.
    - Review targets: server/client request functions and response assertions; repo/cwd root transformations; completion item is likely a legitimate render-ready projection.

28. **Diff viewer**
    - Path: panel open → worktree query → server function → diff route → git status/diff → discriminated response → renderer.
    - Review targets: `StreamInfo`, `DiffResult`, and route responses; server proxy duplicates backend endpoint contract.

29. **Global shortcuts and internal commands**
    - Path: persisted binding strings → parser/index → key events → action dispatch → navigation/internal command insertion.
    - Review targets: action descriptors and picker items are separate render concerns; avoid flattening invariants that protect key sequences.

30. **Theme/settings/browser stores**
    - Path: storage/server user config → settings/theme store → `useSyncExternalStore` → DOM/theme/components; mutations reconnect websocket and invalidate queries.
    - Review targets: `ReturnType` aliases with ownership value; duplicate parsing of browser storage is external-boundary adaptation and may be valid.

31. **Installer/uninstaller deployment**
    - Path: repo assets/config → install plan → permission prompt → manifest/checksum copy/update → hooks/scheduler/process scripts; uninstall reverses manifest with drift checks.
    - High invariant density. Audit only after higher-yield runtime paths; wrappers often encode reversibility and permissions.

32. **Bundled task, notes, learnings, and tmux skills**
    - Path: Pi skill discovery → SKILL instructions → script/CLI → local provider/storage or integration.
    - Separate executable boundaries; review each script against its provider/library types, not against control-surface message contracts.

## Ranked refactor arcs

1. [x] **Pi event → shared websocket contract → browser state — done.** Highest-confidence, high-frequency golden path with low semantic risk. Deleted the duplicate library/shared unions, pass-through sender wrapper, and redundant aliases/casts; the completed cutover removed 270 net source lines and strengthened compile-time drift detection.
2. **Live message/tool commit + persisted history convergence** — highest structural reduction potential but medium risk. `pi-subscribe.ts` and `history.ts` parse the same SDK messages independently; tool calls leave the message, become a side array, become timeline items, then rejoin messages by adjacency. Expected reduction: 150–300 lines after choosing one SDK-message→timeline conversion.
3. **HTTP and websocket inbound routing convergence** — strong evidence, medium risk. Two entry points independently classify, form routing metadata, normalize delivery/images, and call `enqueue`; one identity formatter and wrapper result are dead weight. Expected reduction: 80–160 lines.
4. **Blackboard Pi-session adapter removal** — strong evidence, medium risk. `blackboard/pi-sessions.ts` is largely a same-shape facade over `write-pi-sessions.ts`, while callers and names drift. Expected reduction: 100–170 lines.
5. **Agent history/cache dedup identity consolidation** — strong evidence, medium-high regression risk. ID matching is repeated across live commit, generic append, page merge, and surface commit. Define one identity/equivalence primitive only if it expresses the same invariant in every location. Expected reduction: 60–130 lines.
6. **Status stream projection convergence** — moderate evidence, low-medium risk. Open and closed stream mappings repeat fields; browser adds a broad offline parallel shape. Expected reduction: 50–100 lines.
7. **WhatsApp IPC/status contract convergence** — moderate evidence, medium risk. Status and daemon contracts are renamed and projected across process, socket, runtime, and UI boundaries. Expected reduction: 50–120 lines.
8. **Session list/transcript contract cleanup** — moderate evidence, medium risk. Duplicate raw transcript and row/list aliases exist, but transcript normalization is a real semantic boundary. Expected reduction: 40–90 lines.
9. **Queue input/image/ID identity cleanup** — high potential, higher risk. `EnqueueInput`, `QueueItem`, Pi prompt input, and metadata shift IDs and image forms; external coalescing has distinct lifecycle semantics and must remain explicit. Expected reduction: 60–140 lines.
10. **Provider model/auth projection cleanup** — moderate potential, high change surface because SDK auth/model lifecycles are external and UI-oriented projections may be legitimate. Expected reduction: 50–120 lines.

## Item 1 execution plan — completed

### Canonical chain

```text
Pi AgentSessionEvent (SDK-owned)
→ one server adaptation to ControlSurfaceWebSocketServerEvent
→ JSON transport
→ ControlSurfaceWebSocketServerEvent (shared contract in browser)
→ library-owned TanStack Query / keyed conversation snapshots
→ ChatTimelineItem or ephemeral streaming/tool state
```

Browser commands use the inverse shared contract:

```text
WebSocketClientMessageEvent / subscribe / unsubscribe / ping
→ JSON transport
→ ControlSurfaceWebSocketClientEvent
→ runtime routing/queue
```

### Cutover

- Replace local `PiSessionSubscriptionEvent` and `SubscribablePiSession` with SDK `AgentSessionEvent` and `AgentSession`.
- Delete browser `WsMessage`; use `ControlSurfaceWebSocketServerEvent` directly from the shared contract.
- Build outbound browser payloads as shared client event types instead of `Record<string, unknown>`.
- Delete `createSendMessage`, `SendMessageFn`, and the catch/rethrow pass-through; bind the websocket client method directly in router context.
- Remove type casts and temporary event-type aliases made unnecessary by canonical types.
- Preserve the single valid shape change: SDK messages/events become app timeline/websocket events at `pi-subscribe.ts`.
- Do not merge live and history parsing in this item; that is ranked item 2 and needs dedicated behavioral validation.

### Validation

- Format changed source and plan files.
- Run root and web TypeScript checks without starting/building servers.
- Run Biome and relevant static analysis.
- Run repository tests if test globs are present; otherwise record that no test files exist and rely on contract-level type/static checks.
- Inspect final diff for net code reduction, stale aliases, and accidental protected-doc edits.

## Completion record

Item 1 completed.

- Replaced the handwritten Pi session/session-event projections with SDK `AgentSession`/`AgentSessionEvent` typing through `AgentSession.subscribe`.
- Deleted browser `WsMessage`; `FlitterbotWsClient` now parses and publishes the shared `ControlSurfaceWebSocketServerEvent` union, which the query bridge receives by inference.
- Typed browser message, ping, subscribe, and unsubscribe payloads with shared client event contracts.
- Deleted `createSendMessage`, `SendMessageFn`, and their option type; router context binds `FlitterbotWsClient.sendMessage` directly.
- Deleted unused `toolcall_start` transport/event handling. Tool execution transport now reflects required SDK fields and no longer sends raw SDK events alongside selected fields.
- Removed provisional raw-event fallback from tool completion; the required canonical `result` field now moves unchanged into active tool state.
- Source diff: **85 additions, 355 deletions; net −270 lines** across seven TypeScript files.
- Validation passed: root TypeScript, web TypeScript, Biome over `src/` and `web/src/`, root Knip, web Knip, stale-symbol search, and `git diff --check`.
- The repository currently contains no test files, although package scripts retain test globs; no test server or build/dev server was run.
