# TypeScript Type Audit Manifest

> Generated 2026-03-25 on branch `001-autonoma-typescript-type-audit`
> tsconfig: `strict: true`, `noUncheckedIndexedAccess: true`, `skipLibCheck: true`

---

## Section 1 — Dependency Type Catalog

### @whiskeysockets/baileys (v7.0.0-rc.9)

All types importable from `@whiskeysockets/baileys` (re-exported from `lib/Types`).

| Type | Used for |
|------|----------|
| `WASocket` | Main socket interface |
| `ConnectionState` | Connection open/connecting/close state |
| `DisconnectReason` | Enum for disconnect codes |
| `AuthenticationState` | Auth state container (creds + key store) |
| `AuthenticationCreds` | Full auth credentials |
| `WAMessage` | Full message with key and metadata |
| `WAMessageKey` | Message key (remoteJid, fromMe, id) |
| `WAMessageContent` | Proto message content union |
| `AnyMessageContent` | Union of all sendable message types |
| `MessageUpsertType` | `'append' \| 'notify'` |
| `BaileysEventMap` | All event types and payloads |
| `BaileysEventEmitter` | Event emitter interface |
| `Contact` | Contact info |
| `GroupMetadata` | Group info |
| `MessageReceiptType` | Read receipt types |
| `WAPresence` | Presence status |
| `proto` | Protobuf message namespace |
| `BinaryNode` | Internal binary node |

### openai (v5.x)

Main import: `import OpenAI from "openai"`.

| Type | Import path | Used for |
|------|-------------|----------|
| `OpenAI` | `openai` | Client class |
| `ChatCompletion` | `openai/resources/chat/completions` | Non-streaming response |
| `ChatCompletionCreateParamsNonStreaming` | `openai/resources/chat/completions` | Request params |
| `ChatCompletionMessageParam` | `openai/resources/chat/completions` | Message union |
| `ChatCompletionSystemMessageParam` | `openai/resources/chat/completions` | System message |
| `ChatCompletionUserMessageParam` | `openai/resources/chat/completions` | User message |
| `ChatModel` | `openai/resources/shared` | Model string union |

### @mariozechner/pi-ai (v0.57.1+)

| Type | Used for |
|------|----------|
| `Message` | Union of User/Assistant/ToolResult messages |
| `UserMessage` | User input |
| `AssistantMessage` | Model response with content, usage, stop reason |
| `ToolCall` | Tool invocation (name, id, arguments) |
| `Usage` | Token usage metrics |
| `Context` | systemPrompt + messages + tools |
| `Tool<T>` | Tool definition with TypeBox schema |
| `Model<TApi>` | Provider model with id, costs, context window |
| `StreamOptions` | Request options (temperature, maxTokens, etc.) |
| `StopReason` | `"stop" \| "length" \| "toolUse" \| "error" \| "aborted"` |
| `AssistantMessageEvent` | Discriminated union of streaming events |
| `ThinkingLevel` | `"minimal" \| "low" \| "medium" \| "high" \| "xhigh"` |
| `getModel()` | Retrieve model config by provider + ID |

### @mariozechner/pi-coding-agent (v0.57.1+)

| Type | Used for |
|------|----------|
| `AgentSession` | Main agent session manager |
| `AgentSessionConfig` | Configuration for agent session |
| `AgentSessionEvent` | Events emitted during session |
| `TurnEndEvent` | End-of-turn event |
| `ToolDefinition` | Custom tool definition interface |
| `SessionManager` | Session persistence manager |
| `SessionEntry` | Various entry types in session history |
| `SettingsManager` | Settings persistence |
| `AuthStorage` | Credential storage |
| `DefaultResourceLoader` | Loads skills, agents, config |
| `ModelRegistry` | Model + auth management |
| `createAgentSession()` | Create new agent session |
| `createBashTool()` / `createReadTool()` / `createGrepTool()` | SDK tool factories |

### pino (v10.x)

| Type | Used for |
|------|----------|
| `pino.Logger` | Main logger instance type |
| `pino.LoggerOptions` | Logger configuration |
| `pino.Level` | `"fatal" \| "error" \| "warn" \| "info" \| "debug" \| "trace"` |
| `pino.ChildLoggerOptions` | Options for child loggers |
| `pino.DestinationStream` | Writable stream for log output |

---

## Section 2 — Findings by File

Legend:
- **ANY** = explicit `any` or `as any`
- **UNK** = `as unknown as T` double-cast
- **REC** = `Record<string, unknown>` or `Record<string, any>`
- **IDX** = index signature `[key: string]: unknown`
- **GEN** = missing generic type parameter
- **HAND** = hand-rolled type duplicating a dependency export
- **CAST** = unsafe `as T` without unknown intermediate

### src/blackboard/

#### src/blackboard/db.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 32 | REC/GEN | `get<T = Record<string, unknown>>` — default generic is loose | Make callers supply explicit T; remove default |
| 38 | REC/GEN | `all<T = Record<string, unknown>>` — same | Same |

#### src/blackboard/migrate.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 9 | CAST | `as { name?: string } \| undefined` | Define `MigrationTableRow` |
| 19 | CAST | `as { version: number }` | Use `MigrationVersionRow` type |
| 34 | CAST | `as { count: number }` | Use shared `CountRow` type |

#### src/blackboard/pi-sessions.ts
CLEAN

#### src/blackboard/query-health-flags.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 37 | UNK | `as unknown as HealthFlagRow[]` | Fix db.all() return type via generic |

#### src/blackboard/query-messages.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 20 | REC | `metadata?: Record<string, unknown>` | Use shared `MessageMetadata` type |
| 41 | REC | `metadata?: Record<string, unknown>` | Same |
| 58 | UNK | `as unknown as MessageRow[]` | Fix via db generic |
| 68 | UNK | `as unknown as MessageRow[]` | Same |
| 78 | UNK | `as unknown as MessageRow[]` | Same |
| 105 | UNK | `as unknown as ConversationSnippet[]` | Same |

#### src/blackboard/query-sessions.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 97 | UNK | `as unknown as ClaudeSessionRow[]` | Fix via db generic |
| 105 | UNK | `as unknown as ClaudeSessionRow[]` | Same |
| 110 | UNK | `as unknown as ClaudeSessionRow \| undefined` | Same |
| 128 | UNK | `as unknown as ClaudeSessionRow \| undefined` | Same |
| 190 | UNK | `as unknown as ClaudeSessionRow[]` | Same |
| 222 | UNK | `as unknown as ClaudeSessionRow[]` | Same |
| 232 | UNK | `as unknown as ClaudeSessionRow[]` | Same |
| 333 | UNK | `as unknown as ClaudeSessionRow[]` | Same |

#### src/blackboard/query-whatsapp.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 6 | CAST | Helper `as T[]` — wraps unsafe cast | Fix db layer instead |
| 10 | CAST | Helper `as T \| undefined` | Same |

#### src/blackboard/query-workstreams.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 8 | UNK | `as unknown as WorkstreamRow[]` | Fix via db generic |
| 12 | UNK | `as unknown as WorkstreamRow \| undefined` | Same |
| 21 | UNK | `as unknown as WorkstreamRow \| undefined` | Same |
| 104 | UNK | `as unknown as WorkstreamRow[]` | Same |

#### src/blackboard/write-messages.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 18 | REC | `metadata?: Record<string, unknown> \| null` | Use shared `MessageMetadata` |
| 47 | UNK | `as unknown as MessageRow` | Fix via db generic |

#### src/blackboard/write-pending-actions.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 56 | UNK | `as unknown as PendingActionRow` | Fix via db generic |
| 62 | REC | `resolutionPayload: Record<string, unknown>` | Create `ActionResolutionPayload` type |
| 81 | UNK | `as unknown as PendingActionRow` | Fix via db generic |
| 86 | REC | `resolutionPayload: Record<string, unknown>` | Same |

#### src/blackboard/write-pi-sessions.ts
CLEAN

#### src/blackboard/write-whatsapp.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 34 | UNK | `as unknown as WhatsAppMessageRow` | Fix via db generic |
| 97 | UNK | `as unknown as WhatsAppMessageRow` | Fix via db generic |
| 122 | UNK | `as unknown as WhatsAppMessageRow` | Fix via db generic |

### src/classifier/

#### src/classifier/classify.ts
CLEAN

#### src/classifier/groq-client.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 33 | GEN | `let lastError: unknown` | Type as `Error \| undefined` |

#### src/classifier/index.ts
CLEAN

### src/claude-sessions/

#### src/claude-sessions/index.ts
CLEAN

#### src/claude-sessions/send-message.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 56 | GEN | `new Promise((resolve) => setTimeout(...))` | `new Promise<void>(...)` |

#### src/claude-sessions/tmux.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 183 | GEN | `new Promise((resolve) => setTimeout(...))` | `new Promise<void>(...)` |
| 200 | GEN | `new Promise((resolve) => setTimeout(...))` | `new Promise<void>(...)` |

### src/config/

#### src/config/load-config.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 61 | REC | `readJsonFile<Record<string, unknown>>(CONFIG_PATH)` | Define `RawConfigJson` type or use zod schema |
| 68-102 | CAST | Multiple `String(raw.field)` / `Number(raw.field)` coercions from unknown | Type-narrow with guards or use a validation library |

### src/contracts/

#### src/contracts/blackboard.ts
CLEAN

#### src/contracts/control-surface-api.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 105 | REC | `metadata?: Record<string, unknown>` | Use shared `MessageMetadata` type |
| 128 | IDX | `[key: string]: unknown` in `ClaudeHookPayload` | Enumerate known fields |

#### src/contracts/index.ts
CLEAN

#### src/contracts/message.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 19 | REC | `metadata?: Record<string, unknown>` | Use shared `MessageMetadata` |

#### src/contracts/tmux-bridge.ts
CLEAN

#### src/contracts/transcript.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 28 | REC | `metadata: Record<string, unknown>` | Use shared `MessageMetadata` |

#### src/contracts/websocket.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 47 | REC | `metadata?: Record<string, unknown>` | Use shared `MessageMetadata` |

### src/custom-tools/

#### src/custom-tools/index.ts
CLEAN

#### src/custom-tools/close-workstream.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 222 | ANY | `params: any` | Create `CloseWorkstreamParams` type |

#### src/custom-tools/create-worktree.ts
CLEAN

#### src/custom-tools/manage-session.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 32 | CAST | `reason as DirectSessionMessageFailureReason` | Narrow type at source |
| 69 | CAST | `(delivery as { reason?: string }).reason as DirectSessionMessageFailureReason` | Type delivery result properly |

### src/pi/

#### src/pi/create-agent.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 103 | ANY | `(model as any).providerId ?? (model as any).provider` | Import `Model` type from pi-ai; access typed fields |
| 104 | ANY | `(model as any).modelId ?? (model as any).id` | Same |

#### src/pi/format-prompt.ts
CLEAN

#### src/pi/history.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 16 | REC | `asRecord()` returns `Record<string, unknown>` | Acceptable for JSON parsing; document contract |
| 40,47,57,190,292 | REC | Multiple `Record<string, unknown>` usages for parsed session JSON | Create `RawSessionEntry` type |

#### src/pi/index.ts
CLEAN

#### src/pi/session-manager.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 279 | ANY | `queue: undefined as any` | Use builder pattern or `Partial<ManagedPiSession>` |
| 287 | ANY | `unsubscribe: undefined as any` | Same |
| 307 | ANY | `(error as any).status`, `(error as any).body` (×4) | Create `ApiError` interface |

#### src/pi/session-state.ts
CLEAN

#### src/pi/subscribe.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 18 | GEN | `message?: unknown` in message_update event | Type using pi-coding-agent's message type |
| 26 | GEN | `message?: unknown` in message_end event | Same |
| 34 | IDX | `[key: string]: unknown` on tool_execution_start | Enumerate known fields; drop index sig |
| 42 | IDX | `[key: string]: unknown` on tool_execution_end | Same |
| 47 | IDX | `[key: string]: unknown` on agent_end | Same |
| 50-51 | IDX | `{ type: string; [key: string]: unknown }` catch-all | Remove; enumerate all event types |
| 56 | GEN | `messages: Array<unknown>` in SubscribablePiSession | Use pi-coding-agent's `SessionEntry[]` or `Message[]` |
| 67,78,90,103,115 | REC | Multiple `as Record<string, unknown>` casts for message inspection | Use pi-coding-agent message types |

#### src/pi/turn-queue.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 9 | REC | `metadata?: Record<string, unknown>` | Use shared `MessageMetadata` |

### src/prompts/

#### src/prompts/classifier.ts
CLEAN

#### src/prompts/default-agent.ts
CLEAN

#### src/prompts/index.ts
CLEAN

#### src/prompts/orchestrator.ts
CLEAN

### src/routes/

#### src/routes/_shared.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 3 | ANY | `readJsonBody<T = any>` — default generic is `any` | Change default to `unknown`, force callers to specify T |

#### src/routes/browser-pi.ts
CLEAN

#### src/routes/browser-sessions.ts
CLEAN

#### src/routes/browser-skills.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 15 | ANY | `skills.map((s: any) => ...)` | Import `Skill` type from pi-coding-agent |

#### src/routes/browser-transcript.ts
CLEAN

#### src/routes/cron-tick.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 86 | CAST | `.get() as { count: number }` | Use shared `CountRow` type |

#### src/routes/direct-session-message.ts
CLEAN

#### src/routes/hooks.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 16 | REC | `payload as Record<string, unknown>` (×2) | Add `session_id`/`sessionId` to `ClaudeHookPayload` |

#### src/routes/index.ts
CLEAN

#### src/routes/message.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 32 | REC | `let workstreamMeta: Record<string, unknown> = {}` | Create `WorkstreamRoutingMeta` type |
| 58 | REC | Return type `{ metadata: Record<string, unknown> }` | Same |
| 63 | REC | `const meta: Record<string, unknown>` | Same |
| 94 | REC | `_metadata?: Record<string, unknown>` | Use shared `MessageMetadata` |

#### src/routes/runtime-whatsapp.ts
CLEAN

#### src/routes/status.ts
CLEAN

#### src/routes/stop.ts
CLEAN

### src/transcript/

#### src/transcript/index.ts
CLEAN

#### src/transcript/reader.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 32 | REC | `let obj: Record<string, unknown>` | Create `RawTranscriptEntry` type |
| 40 | REC | `obj.message as Record<string, unknown>` | Same |
| 75-78 | REC/CAST | `(block as Record<string, unknown>).type === "text"` (×3) | Create `ContentBlock` discriminated union |

#### src/transcript/transcript.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 10 | REC | `asRecord()` returns `Record<string, unknown>` | Create `RawTranscriptEntry` type |
| 51 | REC | `detectToolStatus(record: Record<string, unknown>)` | Same |
| 81-99 | REC/CAST | Multiple field extractions from `Record<string, unknown>` with `as` casts | Same |

### src/whatsapp/

#### src/whatsapp/auth.ts
CLEAN

#### src/whatsapp/cli.ts
CLEAN

#### src/whatsapp/config.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 19 | REC | `isRecord()` type guard returns `Record<string, unknown>` | Acceptable for JSON guard |
| 23 | REC | `readJsonObject()` returns `Record<string, unknown>` | Create `WhatsAppConfigJson` type |

#### src/whatsapp/daemon.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 64-68 | HAND | Hand-rolled error shape `{ output?: { statusCode?: number }; ... }` | Use baileys `ConnectionState` error type or `Boom` |
| 241 | CAST | `upsert.messages as WAMessage[]` | Check if redundant; baileys may already type it |
| 267 | HAND | `updates as Array<{ key?: { id?: string } }>` | Use `MessageUserReceiptUpdate` from baileys |
| 480 | ANY | `(this.socket?.ev as any)?.removeAllListeners?.()` | Import `BaileysEventEmitter`; it has `removeAllListeners` |
| 481 | UNK | `this.socket as unknown as { ws?: { close: () => void } }` | Check if baileys exports a transport type |

#### src/whatsapp/ipc.ts
CLEAN

#### src/whatsapp/paths.ts
CLEAN

#### src/whatsapp/process.ts
CLEAN

#### src/whatsapp/receive.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 45-55 | HAND/REC | `unwrapMessageContent()` returns `Record<string, unknown>` with hand-rolled wrapper types | Use baileys `proto.Message` type |
| 69-77 | HAND | Hand-rolled message content shape (conversation, extendedTextMessage, etc.) | Use baileys `proto.Message` sub-types |
| 94-100 | HAND | Hand-rolled contextInfo shape | Use baileys `proto.IContextInfo` |

#### src/whatsapp/send.ts
CLEAN

### src/ws/

#### src/ws/hub.ts
CLEAN

### Root files

#### src/runtime.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 65 | REC | `parameters: Record<string, unknown>` in CustomToolDefinition | Acceptable for JSON Schema params |
| 66 | ANY | `params: any` in execute signature | Create `ToolExecuteParams` generic or per-tool param types |
| 75 | REC | `metadata?: Record<string, unknown>` in EnqueueInput | Use shared `MessageMetadata` |
| 267 | REC | `payload: Record<string, unknown>` in handleHook | Use `ClaudeHookPayload` |
| 360 | REC | `payload as Record<string, unknown>` | Same |
| 628-632 | ANY | `(lastMsg as any).stopReason` etc. (×4) | Create `PiMessage` type with stopReason/error fields |
| 740 | ANY | `session: any` in detectCloseWorkstream | Use `AgentSession` from pi-coding-agent |
| 745 | REC | `messages[i] as Record<string, unknown>` | Use pi-coding-agent message types |
| 747 | ANY | `(msg as any).toolName` | Same |
| 752 | ANY | `msg.content as any[]` | Create `ContentBlock[]` type |
| 779 | ANY | `params: any` in tool execute | Per-tool param type |
| 840 | ANY | `params: any` | Same |
| 928 | ANY | `params: any` | Same |
| 1044 | ANY | `params: any` | Same |
| 1069 | ANY | `params: any` | Same |
| 1098 | REC | `Array<Record<string, unknown>>` return | Acceptable for dynamic SQL |
| 1109 | REC | `.all() as Array<Record<string, unknown>>` | Same |
| 1310 | REC | `let routerMeta: Record<string, unknown> = {}` | Use `WorkstreamRoutingMeta` |
| 1359 | ANY | `session: any` in extractFinalAssistantMessage | Use `AgentSession` |
| 1363 | REC | `session.messages[i] as Record<string, unknown>` | Use pi-coding-agent types |
| 1373-1374 | ANY | `(block: any) =>` filter/map | Create `ContentBlock` type |

#### src/server.ts
| Line | Cat | Issue | Fix |
|------|-----|-------|-----|
| 6 | CAST | `socket as import("node:net").Socket` | Type the callback parameter correctly |

#### src/qrcode-terminal.d.ts
CLEAN (ambient declaration file)

---

## Section 3 — Shared Types Needed

These types should be added to `src/contracts/` to replace scattered `Record<string, unknown>` and hand-rolled shapes across multiple files.

### 3.1 `MessageMetadata`

**Used in:** contracts/message.ts:19, contracts/websocket.ts:47, contracts/control-surface-api.ts:105, contracts/transcript.ts:28, blackboard/query-messages.ts:20+41, blackboard/write-messages.ts:18, pi/turn-queue.ts:9, runtime.ts:75, routes/message.ts:94

```typescript
type MessageMetadata = {
  router_action?: string;
  workstream_id?: string;
  workstream_name?: string;
  _targetSessionId?: string;
  serverMessageId?: string;
  [key: string]: unknown; // keep open for extensibility, but with known fields typed
};
```

### 3.2 `WorkstreamRoutingMeta`

**Used in:** routes/message.ts:32+58+63, runtime.ts:1310

```typescript
type WorkstreamRoutingMeta = {
  router_action?: string;
  workstream_id?: string;
  workstream_name?: string;
  _targetSessionId?: string;
};
```

### 3.3 `CountRow`

**Used in:** blackboard/migrate.ts:34, blackboard/query-sessions.ts:333+349, routes/cron-tick.ts:86

```typescript
type CountRow = { count: number };
```

### 3.4 `ActionResolutionPayload`

**Used in:** blackboard/write-pending-actions.ts:62+86

```typescript
type ActionResolutionPayload = {
  resolvedBy: string;
  deliveryResult?: Record<string, unknown>;
  error?: string;
};
```

### 3.5 `ContentBlock`

**Used in:** runtime.ts:67+752+1373, transcript/reader.ts:75-78

```typescript
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; id: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };
```

### 3.6 `ApiError`

**Used in:** pi/session-manager.ts:307, could also replace patterns in runtime.ts

```typescript
interface ApiError extends Error {
  status?: number;
  body?: unknown;
}
```

### 3.7 `ClaudeHookPayload` expansion

**Currently at:** contracts/control-surface-api.ts:128 with `[key: string]: unknown`

Add known fields: `session_id?: string; sessionId?: string; lastAssistantText?: string;` — eliminates the `Record<string, unknown>` casts in routes/hooks.ts:16 and runtime.ts:360.

### 3.8 `RawTranscriptEntry`

**Used in:** transcript/reader.ts:32+40, transcript/transcript.ts:10+51

```typescript
type RawTranscriptEntry = {
  role?: string;
  sender?: string;
  author?: string;
  type?: string;
  kind?: string;
  event_name?: string;
  event?: string;
  text?: string;
  content?: unknown;
  message?: RawTranscriptEntry;
  summary?: string;
  error?: string;
  status?: string;
  tool_status?: string;
  toolStatus?: string;
  timestamp?: string | number;
  created_at?: string | number;
};
```

---

## Section 4 — Proposed Session Assignments

Files are grouped by domain directory into **15 non-overlapping batches**. Complexity is estimated as: **S** (1-3 issues, mechanical), **M** (4-8 issues, some judgment), **L** (9+ issues, design decisions needed).

### Batch 1 — Blackboard DB Layer (prerequisite for all blackboard batches)
**Complexity: M** — Fixing the db wrapper eliminates ~25 `as unknown as` casts downstream.
| File | Issues |
|------|--------|
| `src/blackboard/db.ts` | 2 (loose generic defaults) |
| `src/blackboard/migrate.ts` | 3 (unsafe casts) |

**Key decision:** Make `get<T>()` and `all<T>()` require an explicit type parameter (no default). This is the single highest-leverage fix — it eliminates every `as unknown as T` in blackboard/.

### Batch 2 — Blackboard Query Files (depends on Batch 1)
**Complexity: M** — Mechanical once db layer is fixed.
| File | Issues |
|------|--------|
| `src/blackboard/query-health-flags.ts` | 1 |
| `src/blackboard/query-messages.ts` | 6 |
| `src/blackboard/query-sessions.ts` | 8 |
| `src/blackboard/query-whatsapp.ts` | 2 |
| `src/blackboard/query-workstreams.ts` | 4 |

### Batch 3 — Blackboard Write Files (depends on Batch 1)
**Complexity: M**
| File | Issues |
|------|--------|
| `src/blackboard/write-messages.ts` | 2 |
| `src/blackboard/write-pending-actions.ts` | 4 |
| `src/blackboard/write-whatsapp.ts` | 3 |
| `src/blackboard/write-pi-sessions.ts` | 0 (CLEAN) |
| `src/blackboard/pi-sessions.ts` | 0 (CLEAN) |

### Batch 4 — Shared Contracts (prerequisite for many downstream batches)
**Complexity: M** — Define MessageMetadata, CountRow, ContentBlock, expand ClaudeHookPayload.
| File | Issues |
|------|--------|
| `src/contracts/message.ts` | 1 |
| `src/contracts/control-surface-api.ts` | 2 |
| `src/contracts/websocket.ts` | 1 |
| `src/contracts/transcript.ts` | 1 |
| `src/contracts/blackboard.ts` | 0 (CLEAN) |
| `src/contracts/tmux-bridge.ts` | 0 (CLEAN) |
| `src/contracts/whatsapp.ts` | 0 (CLEAN) |
| `src/contracts/index.ts` | 0 (CLEAN) |

### Batch 5 — Classifier
**Complexity: S**
| File | Issues |
|------|--------|
| `src/classifier/groq-client.ts` | 1 |
| `src/classifier/classify.ts` | 0 (CLEAN) |
| `src/classifier/index.ts` | 0 (CLEAN) |

### Batch 6 — Claude Sessions
**Complexity: S**
| File | Issues |
|------|--------|
| `src/claude-sessions/send-message.ts` | 1 |
| `src/claude-sessions/tmux.ts` | 2 |
| `src/claude-sessions/index.ts` | 0 (CLEAN) |

### Batch 7 — Config
**Complexity: S**
| File | Issues |
|------|--------|
| `src/config/load-config.ts` | 2 |

### Batch 8 — Pi Agent Core
**Complexity: L** — Requires understanding pi-coding-agent SDK types for model and session typing.
| File | Issues |
|------|--------|
| `src/pi/create-agent.ts` | 2 |
| `src/pi/session-manager.ts` | 4 |

### Batch 9 — Pi Subscribe & Events
**Complexity: L** — Needs event type design decisions; coordinate with pi-coding-agent SDK types.
| File | Issues |
|------|--------|
| `src/pi/subscribe.ts` | 12 |

### Batch 10 — Pi History & Queue
**Complexity: M** — JSON parsing boundary; create `RawSessionEntry` type.
| File | Issues |
|------|--------|
| `src/pi/history.ts` | 6 |
| `src/pi/turn-queue.ts` | 1 |
| `src/pi/session-state.ts` | 0 (CLEAN) |
| `src/pi/format-prompt.ts` | 0 (CLEAN) |
| `src/pi/index.ts` | 0 (CLEAN) |

### Batch 11 — WhatsApp Daemon
**Complexity: L** — Requires importing baileys types; hand-rolled shapes need replacement.
| File | Issues |
|------|--------|
| `src/whatsapp/daemon.ts` | 5 |

### Batch 12 — WhatsApp Receive & Config
**Complexity: M** — Replace hand-rolled message types with baileys proto types.
| File | Issues |
|------|--------|
| `src/whatsapp/receive.ts` | 3 |
| `src/whatsapp/config.ts` | 2 |
| `src/whatsapp/auth.ts` | 0 (CLEAN) |
| `src/whatsapp/cli.ts` | 0 (CLEAN) |
| `src/whatsapp/ipc.ts` | 0 (CLEAN) |
| `src/whatsapp/paths.ts` | 0 (CLEAN) |
| `src/whatsapp/process.ts` | 0 (CLEAN) |
| `src/whatsapp/send.ts` | 0 (CLEAN) |

### Batch 13 — Runtime (Part 1: Tool Definitions)
**Complexity: L** — Highest issue density; needs per-tool param types and ContentBlock.
| File | Issues |
|------|--------|
| `src/runtime.ts` lines 1-800 | ~12 (tool execute signatures, `as any` casts, deferred session typing) |

### Batch 14 — Runtime (Part 2: Orchestration & Helpers)
**Complexity: L** — Message inspection, hook handling, close-workstream detection.
| File | Issues |
|------|--------|
| `src/runtime.ts` lines 800+ | ~8 (session-as-any, Record casts, block filtering) |
| `src/custom-tools/close-workstream.ts` | 1 |
| `src/custom-tools/manage-session.ts` | 2 |
| `src/custom-tools/create-worktree.ts` | 0 (CLEAN) |
| `src/custom-tools/index.ts` | 0 (CLEAN) |

### Batch 15 — Routes, Transcript, Server, WS
**Complexity: M**
| File | Issues |
|------|--------|
| `src/routes/_shared.ts` | 1 |
| `src/routes/browser-skills.ts` | 1 |
| `src/routes/cron-tick.ts` | 1 |
| `src/routes/hooks.ts` | 1 |
| `src/routes/message.ts` | 4 |
| `src/transcript/reader.ts` | 3 |
| `src/transcript/transcript.ts` | 3 |
| `src/server.ts` | 1 |
| `src/ws/hub.ts` | 0 (CLEAN) |
| `src/transcript/index.ts` | 0 (CLEAN) |
| `src/routes/browser-pi.ts` | 0 (CLEAN) |
| `src/routes/browser-sessions.ts` | 0 (CLEAN) |
| `src/routes/browser-transcript.ts` | 0 (CLEAN) |
| `src/routes/direct-session-message.ts` | 0 (CLEAN) |
| `src/routes/index.ts` | 0 (CLEAN) |
| `src/routes/runtime-whatsapp.ts` | 0 (CLEAN) |
| `src/routes/status.ts` | 0 (CLEAN) |
| `src/routes/stop.ts` | 0 (CLEAN) |
| `src/prompts/classifier.ts` | 0 (CLEAN) |
| `src/prompts/default-agent.ts` | 0 (CLEAN) |
| `src/prompts/index.ts` | 0 (CLEAN) |
| `src/prompts/orchestrator.ts` | 0 (CLEAN) |
| `src/qrcode-terminal.d.ts` | 0 (CLEAN) |

---

## Execution Order

```
Batch 1 (db layer)  ──┬──→  Batch 2 (queries)
                      └──→  Batch 3 (writes)

Batch 4 (contracts) ──────→  Batch 8-14 (consumers)

Batches 5-7, 11-12, 15  →  Independent, run in parallel
Batches 8-10             →  Depend on pi-coding-agent type understanding
Batches 13-14            →  Depend on Batch 4 (contracts) + Batch 8 (pi types)
```

## Issue Count Summary

| Category | Count |
|----------|-------|
| `as unknown as T` double-casts (UNK) | 25 |
| Explicit `any` / `as any` (ANY) | 22 |
| `Record<string, unknown>` (REC) | 38 |
| Index signatures `[key: string]: unknown` (IDX) | 5 |
| Hand-rolled dependency types (HAND) | 5 |
| Unsafe `as T` casts (CAST) | 10 |
| Missing generic params (GEN) | 5 |
| **Total** | **~110** |
| Files with issues | 35 |
| Clean files | 33 |
