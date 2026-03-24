# Control Surface — FEATURE.md Audit

Audited 2026-03-24 against commit `58182b8` (main).

---

## Matches

These claims in FEATURE.md are accurate and verified against implementation:

- **HTTP endpoints**: All 11 documented routes exist with correct methods, paths, and auth requirements. No undocumented routes found.
- **Port/host**: `:18820` on `127.0.0.1` (localhost only) — `config/load-config.ts:93-94`.
- **Auth model**: Read-only `/api/*` + `/status` unauthenticated; all mutating routes require bearer token via `requireBearer()`.
- **PiSessionManager**: Manages default agent (singleton) + orchestrators (per-workstream, ephemeral). `session-manager.ts:34-36`.
- **ManagedPiSession structure**: Bundles agent session, TurnQueue, PiSessionState, role, workstream binding, WebSocket subscription. `session-manager.ts:16-27`.
- **TurnQueue**: FIFO with steer-interrupt bypass. `turn-queue.ts:44-48` (steer), `70-87` (FIFO pump).
- **formatPromptWithContext()**: Pass-through stub returning `item.text` unchanged. `format-prompt.ts:8-10`.
- **Blackboard**: SQLite at `~/.autonoma/blackboard.db` with WAL mode. `db.ts:14`.
- **Blackboard tables**: All 7 tables present — workstreams, sessions, pi_sessions, messages, whatsapp_messages, health_flags, pending_actions.
- **Enums**: `ClaudeSessionStatus`, `PiSessionStatus`, `WorkstreamStatus` all match documented values. `contracts/blackboard.ts:3-10`.
- **Classifier**: Groq LLM via OpenAI-compatible API at `api.groq.com`. `groq-client.ts:3,16-19`.
- **WebSocketHub**: Raw RFC 6455 implementation (no library). Manual frame encoding/decoding, SHA1 handshake. `ws/hub.ts`.
- **WebSocket events**: All 10 documented event types present in `contracts/websocket.ts:48-149`.
- **Custom tools**: `query_blackboard` (read-only SQL), `reload_resources`, `create_workstream` (default-only), `create_worktree` (orchestrator-only, NNN-slug + git-town), `close_workstream` (orchestrator-only, kill/merge/push/cleanup).
- **WhatsApp**: Baileys daemon as separate process, 5s echo window (`receive.ts:19`), dedup on `wa_message_id`, supports conversation/extendedText/image/video/document types (`receive.ts:71-76`), outbound via daemon IPC.
- **Session persistence**: JSONL on disk via Pi SDK. `pi_sessions` SQLite table mirrors runtime state. Startup reconciliation via `reconcilePreviousPiSessions()`.
- **Pi model default**: `claude-opus-4-6` — `config/load-config.ts:99`.

---

## Divergences

| FEATURE.md Claim | Actual Implementation | Location |
|---|---|---|
| `enqueue_message` is an **orchestrator** tool (line 55) | Registered as **default-only** — inside `if (role === "default")` block | `runtime.ts:824,909` |
| Workstream soft-delete with **6h** visibility window (line 86, 202) | Callers pass **24 hours** to `listRecentlyClosedWorkstreams()` | `runtime.ts:467`, `routes/browser-pi.ts:96` |

---

## Missing from Doc

Implementation details present in code but not captured in FEATURE.md:

- **`agent` message source**: Messages table CHECK constraint includes `'agent'` as a valid source (added in schema v11). Doc only lists `whatsapp | web | hook | cron | init | pi_outbound`.
- **Schema version**: Currently v11 in code (`contracts/blackboard.ts:1`). Not mentioned in doc.
- **`manage-session.ts` is not a Pi tool**: Listed in "Key Source Files" as "Direct CC session messaging via tmux" which could imply it's a custom tool. It's actually only an HTTP endpoint handler (`/sessions/:id/message`), not exposed to Pi.
- **`wipeWorkstreamsOnStart` config flag**: Runtime can wipe all open workstreams on startup (`runtime.ts:133-136`). Not documented.
- **Stuck turn detection**: Cron-based watchdog detects stuck Pi turns exceeding `toolTimeoutMinutes` and sets circuit breaker (`runtime.ts:1250-1264`). Not documented.
- **Orchestrator rehydration on startup**: Open workstreams from SQLite trigger orchestrator re-creation (`runtime.ts:141-149`). Mentioned obliquely in "reconciles previous sessions" but the orchestrator respawn is a distinct behavior.
- **Groq model**: Classifier uses `openai/gpt-oss-120b` via Groq (`groq-client.ts:3`). Doc says "Groq-based classifier" but doesn't name the model.

---

## Missing from Implementation

Claims in FEATURE.md with no corresponding implementation found:

- **Context header injection** (line 53): Doc notes it's "stubbed but not yet implemented" and the Observations section confirms this. `formatPromptWithContext()` remains a pass-through. This is accurately self-documented as unimplemented.

No other documented features were found to be missing from the implementation.
