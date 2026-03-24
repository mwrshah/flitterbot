# Feature: WhatsApp Channel

Bidirectional WhatsApp messaging via Baileys — the orchestrator's primary channel for reaching the user away from terminal or web app.

## Problem

Sessions stall, tasks come due, the agent needs permission — all while the user is away from the computer. WhatsApp is the fastest channel for reaching and getting responses from the user. The system needs reliable outbound delivery, inbound reply routing back to the orchestrator, and persistent auth that survives restarts.

## Architecture

Standalone Node.js daemon (`daemon.ts`) running as a detached background process. Connects to WhatsApp Web via Baileys, communicates with the control surface over a Unix domain socket (`~/.autonoma/whatsapp/daemon.sock`). The control surface auto-starts the daemon on first WhatsApp command if it isn't running.

```
Control Surface ──IPC (Unix socket)──► WhatsApp Daemon ──Baileys──► WhatsApp Web
                                            │
                                            ▼
                                       Blackboard (SQLite)
```

**IPC protocol** (`ipc.ts`): newline-delimited JSON over Unix domain socket. Three commands: `send`, `status`, `shutdown`. Server creates socket, client connects with 4s timeout. Each request gets one response, then the connection closes.

**Process lifecycle** (`process.ts`): `startDaemonProcess` kills competing daemons first (SIGTERM → 3s wait → SIGKILL), then spawns detached with stdout/stderr redirected to `~/.autonoma/logs/whatsapp-daemon.log`. `waitForDaemonReady` polls the status command until the daemon responds. `stopDaemonProcess` sends shutdown via IPC, falls back to SIGTERM on the PID. Competing daemon detection uses `ps -axo` to find processes matching known daemon paths/socket.

**Configuration** (`config.ts`): `~/.autonoma/whatsapp/config.json` with fields:
- `recipientJid` — target WhatsApp number (required; auto-appends `@s.whatsapp.net`)
- `pairingPhoneNumber` — for pairing code auth (falls back to recipientJid)
- `typingDelayMs` — composing indicator duration before send (default 800ms)
- `daemonStartupTimeoutMs` — how long to wait for daemon ready (default 8000ms)

**File layout** (`paths.ts`): everything under `~/.autonoma/whatsapp/` — `auth/`, `auth-backup/`, `config.json`, `daemon.sock`, `daemon.pid`, `status.signal`. Logs at `~/.autonoma/logs/whatsapp-daemon.log`.

## Message Flow

All delivery is push-based — no polling.

**Outbound**: CLI uses `sendWhatsAppViaDaemon()` (`send.ts`) → IPC send command. Runtime calls `sendDaemonCommand` directly (auto-starts daemon on connection error). Daemon creates outbound record in blackboard (`createOutboundPendingMessage`) → sends typing indicator → delivers via Baileys → marks sent/failed. If a `pendingAction` is included, a `pending_actions` row is created and its context_ref linked to the outbound message. Delivery receipts (`message-receipt.update` event) update the blackboard record to `delivered`.

**Inbound**: Baileys `messages.upsert` fires → daemon filters by allowed JIDs (`getInboundMessageRejectionReason`) → `persistInboundMessage()` runs echo/dedup checks → forwards to control surface via HTTP POST to `/message` → persists to blackboard as secondary concern (DB failure never drops a message). Daemon auto-marks inbound messages as read.

**Inbound message processing** (`receive.ts`):
1. `unwrapMessageContent` — unwraps nested ephemeral/viewOnce/documentWithCaption wrappers
2. `extractConversationBody` — extracts text from conversation, extendedText, or media captions
3. Echo filter: `shouldFilterRecentOutboundEcho` checks if a `fromMe` message matches a recent outbound within 5s
4. Dedup: checks `wa_message_id` against existing inbound records
5. Forward to control surface HTTP POST `/message` with source=whatsapp
6. Persist: resolve context_ref (quoted message → latest pending action → latest outbound with context), insert inbound record

**Reply matching** (`resolveInboundContextRef` in blackboard): three-tier fallback — (1) quoted message's context_ref via stanzaId lookup, (2) latest pending action's context_ref, (3) latest outbound message with a context_ref.

## Authentication

**First setup**: QR code scan or pairing code (`autonoma-wa auth --pairing-code`). `auth.ts` manages `auth/` and `auth-backup/` directories with restrictive permissions (0o700 dirs, 0o600 files).

**Credential lifecycle**: Baileys `useMultiFileAuthState` persists to `auth/`. On every `creds.update`, credentials are saved and backed up. If auth state fails to load, backup is restored automatically. On auth expiry (disconnect code 401/loggedOut), daemon sets status to `logged_out` and creates a `whatsapp_auth_expired` pending action in the blackboard.

**Allowed JIDs**: On connect, the daemon builds a set of accepted inbound JIDs — the configured recipient plus the account's LID (Linked Identity, stripped of device suffix). Rebuilt on every `creds.update` so the LID stays current. Messages from other JIDs are rejected before any processing.

## Connection Management

Daemon tracks status: `starting` → `connecting` → `connected` | `reconnecting` | `auth_required` | `logged_out` | `stopped`. Status changes write a signal file (`status.signal`) so the control surface can detect changes.

**Reconnect logic**: restart-required disconnects (code 515) get one immediate retry. All other disconnects use exponential backoff (1s base, 30s cap). Auth expiry (401/loggedOut) halts reconnection — requires manual re-auth.

## CLI

`cli.ts` provides manual control:

```
autonoma-wa start              # start daemon, wait for ready
autonoma-wa stop               # graceful shutdown
autonoma-wa status             # daemon status as JSON
autonoma-wa send "msg" [--context ref]  # send message
autonoma-wa auth [--pairing-code]       # foreground auth flow (QR or pairing code)
```

## Dependencies

- `@whiskeysockets/baileys` — WhatsApp Web protocol
- `qrcode-terminal` — QR display for auth
- `pino` — structured logging
- Blackboard — message storage, echo dedup, pending actions, delivery tracking

## Constraints

- Single recipient; text-only; low-frequency (few messages per 15-min cycle)
- Command channel for the orchestrator, not a chat platform

## Key Files

```
src/whatsapp/
  daemon.ts    — WhatsAppDaemon class: Baileys connection, event handlers, IPC server, send logic
  receive.ts   — Inbound processing: unwrap, extract, echo/dedup, forward, persist
  send.ts      — sendWhatsAppViaDaemon: IPC client with auto-start retry
  ipc.ts       — Unix socket IPC: createIpcServer + sendDaemonCommand
  process.ts   — Daemon lifecycle: start/stop/status, competing process cleanup
  cli.ts       — CLI entrypoint: start, stop, status, send, auth commands
  config.ts    — Config loading, JID resolution, phone number normalization
  auth.ts      — Auth directory management, backup/restore
  paths.ts     — All filesystem paths under ~/.autonoma/whatsapp/
```

## Observations

`send.ts` is a thin CLI convenience wrapper around `sendDaemonCommand`. The runtime calls `sendDaemonCommand` directly because it needs access to the full `DaemonResponse` (e.g. daemon status cache updates). The two callers have intentionally different needs.

`runtime.ts` `sendWhatsAppCommand` accepts typed `DaemonCommand` and returns `DaemonResponse` — no `as any` casts.

Inbound echo/dedup DB failure logs the error but continues forwarding to the control surface — a transient DB error does not drop messages on this command channel. At worst a duplicate reaches the orchestrator.

Forward-then-persist is a known eventual-consistency gap: if forwarding succeeds but `insertInboundWhatsAppMessage` fails, the message reaches the orchestrator but has no DB record. The persist block catches the error and logs it without failing the flow.
