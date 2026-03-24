# WhatsApp Channel — FEATURE.md Audit

Audited 2026-03-24 against current `main` (58182b8).

## Matches

- **Architecture** — standalone Node.js daemon (`WhatsAppDaemon` class in `daemon.ts`), detached background process, communicates over Unix domain socket (`daemon.sock`). Control surface auto-starts daemon on connection error (`sendWhatsAppCommand` catches, calls `startWhatsAppDaemon`, retries).
- **IPC protocol** — newline-delimited JSON over Unix socket. Three commands: `send`, `status`, `shutdown`. Client connects with 4s timeout (default in `sendDaemonCommand`). Each request gets one response, then socket closes (`socket.end()` in `finally`).
- **Process lifecycle** — `startDaemonProcess` calls `stopCompetingDaemonProcesses` first (SIGTERM → 3s wait → SIGKILL for survivors), spawns detached with stdout/stderr to `~/.autonoma/logs/whatsapp-daemon.log`. `waitForDaemonReady` polls status command until daemon responds. `stopDaemonProcess` sends shutdown IPC, falls back to SIGTERM on PID. Competing daemon detection uses `ps -axo pid=,command=`.
- **Configuration** — `~/.autonoma/whatsapp/config.json` with all four documented fields: `recipientJid`, `pairingPhoneNumber`, `typingDelayMs` (default 800), `daemonStartupTimeoutMs` (default 8000). JID auto-appends `@s.whatsapp.net` via `toWhatsAppJid`.
- **File layout** — all paths match: `auth/`, `auth-backup/`, `config.json`, `daemon.sock`, `daemon.pid`, `status.signal` under `~/.autonoma/whatsapp/`. Logs at `~/.autonoma/logs/whatsapp-daemon.log`.
- **Outbound flow** — `createOutboundPendingMessage` creates DB record → typing indicator (`sendPresenceUpdate("composing")`) → delay by `typingDelayMs` → send via Baileys → mark sent/failed. Pending action creation and context_ref linking implemented. Delivery receipts via `message-receipt.update` update to delivered.
- **Inbound flow** — `messages.upsert` fires → `getInboundMessageRejectionReason` filters by allowed JIDs → `persistInboundMessage` runs echo/dedup → forwards to control surface via HTTP POST `/message` with `source: "whatsapp"` → persists to blackboard. Auto-marks inbound as read (`readMessages`).
- **Inbound processing steps** — all 6 steps match: (1) `unwrapMessageContent` unwraps ephemeral/viewOnce/viewOnceV2/viewOnceV2Extension/documentWithCaption, (2) `extractConversationBody` extracts from conversation/extendedText/image caption/video caption/document caption, (3) echo filter checks `fromMe` + 5s window, (4) dedup via `wa_message_id`, (5) forward to `/message`, (6) persist with context_ref resolution.
- **Reply matching** — `resolveInboundContextRef` implements three-tier fallback: (1) quoted message stanzaId → context_ref lookup, (2) latest pending action's context_ref, (3) latest outbound with context_ref.
- **Authentication** — QR code (via `qrcode-terminal`) and pairing code (`requestPairingCode`). `auth.ts` manages `auth/` and `auth-backup/` with restrictive permissions (0o700 dirs, 0o600 files via `setPermissionsRecursive`). Baileys `useMultiFileAuthState` for persistence. On `creds.update`: save + backup. Failed auth state load → backup restore. Auth expiry (401/loggedOut) → `logged_out` status + `whatsapp_auth_expired` pending action.
- **Allowed JIDs** — built on connect: configured recipient + account LID (stripped of device suffix). Rebuilt on every `creds.update`.
- **Connection statuses** — `starting` → `connecting` → `connected` | `reconnecting` | `auth_required` | `logged_out` | `stopped`. Status changes write `status.signal` file.
- **Reconnect logic** — restart-required (code 515 / `DisconnectReason.restartRequired`) gets one immediate retry (`immediateReconnectUsed` flag). Other disconnects use exponential backoff (`1000 * 2^(attempt-1)`, capped at 30s). Auth expiry halts reconnection.
- **CLI commands** — all 5 match: `start` (start + wait), `stop` (graceful shutdown), `status` (JSON), `send "msg" [--context ref]`, `auth [--pairing-code]`.
- **Dependencies** — `@whiskeysockets/baileys`, `qrcode-terminal`, `pino` all imported. Blackboard used for message storage, echo dedup, pending actions, delivery tracking.
- **Constraints** — single recipient (single `recipientJid`), text-only (sends `{ text }` only).
- **Key Files** — all 8 files exist at documented paths.
- **Observations** — all verified: `send.ts` is thin CLI wrapper; runtime calls `sendDaemonCommand` directly with typed `DaemonCommand` → `DaemonResponse`; DB failure in echo/dedup continues forwarding; forward-then-persist gap documented in code comments.

## Divergences

- **`send.ts` auto-start** — doc says "CLI uses `sendWhatsAppViaDaemon()` → IPC send command. Runtime calls `sendDaemonCommand` directly (auto-starts daemon on connection error)." This is accurate for the runtime, but `sendWhatsAppViaDaemon` (CLI path) does NOT auto-start — it calls `sendDaemonCommand` without retry. Only `runtime.sendWhatsAppCommand` has the auto-start-on-failure retry logic.
- **`stopping` status** — doc lists statuses as `starting → connecting → connected | reconnecting | auth_required | logged_out | stopped`. The implementation also has a `stopping` transitional status (set in `stop()` before cleanup), which is defined in the `WhatsAppDaemonStatus` type in `control-surface-api.ts`. The contract type also includes `unknown`, `disabled`, and `error` statuses.
- **Backoff formula** — doc says "exponential backoff (1s base, 30s cap)". Implementation is `1000 * 2^max(0, attempt-1)` which gives 1s, 2s, 4s, 8s, 16s, 30s — the base is 1s only on the first attempt; subsequent attempts double. The doc is approximately correct but omits the doubling detail.
- **`pendingAction` on send** — doc says "If a `pendingAction` is included, a `pending_actions` row is created and its context_ref linked to the outbound message." Implementation also updates the outbound message's `context_ref` in the DB if the pending action's resolved context_ref differs from the original — a more nuanced linking step than described.
- **Send retry** — the daemon retries once (500ms delay) if the first send returns no message ID. Not mentioned in the doc.

## Missing from Doc

- **`viewOnceMessageV2Extension`** — `unwrapMessageContent` also unwraps this wrapper type, beyond the documented `ephemeral/viewOnce/documentWithCaption`.
- **`viewOnceMessageV2`** — also unwrapped but not explicitly listed in the doc.
- **Video/document captions** — `extractConversationBody` extracts captions from `videoMessage` and `documentMessage` in addition to `imageMessage`. Doc only says "media captions" generically.
- **`extractQuotedWaMessageId`** — extracts stanzaId from `extendedTextMessage`, `imageMessage`, and `videoMessage` context info. Not separately documented.
- **Runtime mirrors web messages to WhatsApp** — `runtime.ts` sends web UI messages to WhatsApp as `*User (web):*` prefixed messages. Not mentioned in this feature doc.
- **Runtime surfaces Pi responses to WhatsApp** — Pi's final assistant messages are forwarded to WhatsApp as `*B-bot:*` prefixed messages. Not in this feature doc.
- **`whatsappEnabled` flag** — `runtime.sendWhatsAppCommand` checks `this.whatsappEnabled` before attempting any WhatsApp operation, returning `{ok: false, status: "disabled"}` if false. Not documented.
- **`runForegroundDaemonProcess`** — separate function for auth mode that runs the daemon in the foreground with `stdio: "inherit"` and `AUTONOMA_WA_EXIT_AFTER_AUTH=1` env var. Only implicitly covered by CLI `auth` command description.
- **`whatsappDaemonPath` config** — `process.ts` supports a configurable daemon entrypoint path via `config.whatsappDaemonPath`, falling back to the co-located `daemon.ts`. Not documented.
- **Socket permissions** — daemon sets `0o600` on the Unix socket after creation. Not documented.
- **`upsert.type` filtering** — daemon only processes `messages.upsert` events with type `notify` or `append`, ignoring others. Not documented.
- **Browser identity** — Baileys connects as `Browsers.macOS("Autonoma")` with `markOnlineOnConnect: false` and `syncFullHistory: false`. Not documented.

## Missing from Implementation

No features described in the doc are missing from the implementation. All flows, auth mechanics, reconnect logic, CLI commands, and reply matching are implemented as described.
