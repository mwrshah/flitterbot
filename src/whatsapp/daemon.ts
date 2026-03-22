import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import makeWASocket, {
  Browsers,
  type ConnectionState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { type BlackboardDatabase, openBlackboard } from "../blackboard/db.ts";
import { createPendingAction } from "../blackboard/writers/pending-actions.ts";
import {
  createOutboundPendingMessage,
  markWhatsAppMessageDelivered,
  markWhatsAppMessageFailed,
  markWhatsAppMessageSent,
} from "../blackboard/writers/whatsapp-writer.ts";
import { loadConfig } from "../config/load-config.ts";
import type {
  DaemonCommand,
  DaemonResponse,
  PendingActionRequest,
  WhatsAppConnectionStatus,
  WhatsAppDaemonRuntimeStatus as WhatsAppDaemonStatus,
} from "../contracts/index.ts";
import {
  backupAuthState,
  ensureAuthDirectories,
  hasStoredAuthState,
  restoreAuthStateBackup,
} from "./auth.ts";
import {
  ensureWhatsAppHome,
  loadWhatsAppConfig,
  resolvePairingPhoneNumber,
  resolveRecipientJid,
} from "./config.ts";
import { createIpcServer } from "./ipc.ts";
import {
  getWhatsAppAuthDir,
  getWhatsAppLogPath,
  getWhatsAppPidPath,
  getWhatsAppSocketPath,
} from "./paths.ts";
import { getInboundMessageRejectionReason, persistInboundMessage } from "./receive.ts";

const logger = pino({ level: process.env.AUTONOMA_WA_LOG_LEVEL ?? "info" });

function timestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDisconnectCode(update: Partial<ConnectionState>): number | undefined {
  const error = update.lastDisconnect?.error as
    | { output?: { statusCode?: number }; statusCode?: number; data?: { statusCode?: number } }
    | undefined;

  return error?.output?.statusCode ?? error?.statusCode ?? error?.data?.statusCode;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class WhatsAppDaemon {
  private db: BlackboardDatabase;
  private socket?: WASocket;
  private ipcServer?: Awaited<ReturnType<typeof createIpcServer>>;
  private shuttingDown = false;
  private immediateReconnectUsed = false;
  private readonly startedAt = timestamp();
  private connectedAt?: string;
  private lastDisconnectAt?: string;
  private reconnectAttempt = 0;
  private status: WhatsAppConnectionStatus = "starting";
  private lastError?: string;
  private readonly options: {
    authMode: boolean;
    pairingCode: boolean;
  };

  constructor(options: { authMode: boolean; pairingCode: boolean }) {
    this.options = options;
    this.db = openBlackboard(loadConfig().blackboardPath);
  }

  async start(): Promise<void> {
    ensureWhatsAppHome();
    ensureAuthDirectories();
    mkdirSync(path.dirname(getWhatsAppLogPath()), { recursive: true, mode: 0o700 });
    this.writePidFile();

    this.ipcServer = await createIpcServer(async (command) => await this.handleCommand(command));
    chmodSync(getWhatsAppSocketPath(), 0o600);

    if (!hasStoredAuthState() && !this.options.authMode) {
      this.status = "auth_required";
      this.lastError = "Missing WhatsApp credentials. Run `autonoma-wa auth` in a terminal.";
      logger.warn(this.lastError);
      return;
    }

    await this.connect();
  }

  private writePidFile(): void {
    writeFileSync(getWhatsAppPidPath(), `${process.pid}\n`, { mode: 0o600 });
  }

  private snapshot(): WhatsAppDaemonStatus {
    let recipientJid: string | undefined;
    try {
      recipientJid = resolveRecipientJid();
    } catch {
      recipientJid = undefined;
    }

    return {
      ok: true,
      pid: process.pid,
      status: this.status,
      recipientJid,
      socketPath: getWhatsAppSocketPath(),
      authPath: getWhatsAppAuthDir(),
      startedAt: this.startedAt,
      connectedAt: this.connectedAt,
      lastDisconnectAt: this.lastDisconnectAt,
      reconnectAttempt: this.reconnectAttempt,
      lastError: this.lastError,
      requiresManualAuth: this.status === "auth_required" || this.status === "logged_out",
    };
  }

  private async handleCommand(command: DaemonCommand): Promise<DaemonResponse> {
    switch (command.command) {
      case "status":
        return {
          ok: true,
          status: this.status,
          pid: process.pid,
          daemon: this.snapshot(),
        };
      case "shutdown":
        await this.stop();
        return {
          ok: true,
          status: "stopped",
        };
      case "send":
        return await this.handleSendCommand(
          command.text,
          command.contextRef,
          command.pendingAction,
        );
      default:
        return {
          ok: false,
          status: "error",
          error: `Unsupported command: ${JSON.stringify(command)}`,
        };
    }
  }

  private async connect(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    const config = loadWhatsAppConfig();
    const recipientJid = resolveRecipientJid(config);
    this.status = this.reconnectAttempt > 0 ? "reconnecting" : "connecting";
    this.lastError = undefined;

    let authState: Awaited<ReturnType<typeof useMultiFileAuthState>>;
    try {
      authState = await useMultiFileAuthState(getWhatsAppAuthDir());
    } catch (error) {
      if (!restoreAuthStateBackup()) {
        throw error;
      }
      authState = await useMultiFileAuthState(getWhatsAppAuthDir());
    }

    const { state, saveCreds } = authState;
    const { version } = await fetchLatestBaileysVersion();

    this.socket = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      printQRInTerminal: false,
      browser: Browsers.macOS("Autonoma"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    this.socket.ev.on("creds.update", async () => {
      await saveCreds();
      backupAuthState();
    });

    this.socket.ev.on("connection.update", async (update) => {
      await this.onConnectionUpdate(update);
    });

    this.socket.ev.on("messages.upsert", async (upsert) => {
      if (upsert.type !== "notify" && upsert.type !== "append") {
        logger.info({ upsertType: upsert.type }, "ignored messages.upsert with unsupported type");
        return;
      }

      for (const message of upsert.messages as WAMessage[]) {
        const rejectionReason = getInboundMessageRejectionReason(message);
        if (rejectionReason || message.key.remoteJid !== recipientJid) {
          logger.info(
            {
              upsertType: upsert.type,
              waMessageId: message.key.id,
              remoteJid: message.key.remoteJid,
              fromMe: message.key.fromMe,
              rejectionReason: rejectionReason ?? `unexpected_remote_jid:${message.key.remoteJid}`,
            },
            "filtered inbound WhatsApp message before persistence",
          );
          continue;
        }

        await persistInboundMessage(this.db, message);
        try {
          await this.socket?.readMessages([message.key]);
        } catch (error) {
          logger.warn({ err: error }, "failed to mark inbound message as read");
        }
      }
    });

    this.socket.ev.on("message-receipt.update", (updates) => {
      for (const update of updates as Array<{ key?: { id?: string } }>) {
        const id = update.key?.id;
        if (id) {
          markWhatsAppMessageDelivered(this.db, id);
        }
      }
    });

    if (this.options.authMode && this.options.pairingCode && !state.creds.registered) {
      setTimeout(async () => {
        if (!this.socket || state.creds.registered) {
          return;
        }

        try {
          const phoneNumber = resolvePairingPhoneNumber(config);
          const code = await this.socket.requestPairingCode(phoneNumber);
          logger.info(`WhatsApp pairing code: ${code}`);
          console.log(`WhatsApp pairing code: ${code}`);
        } catch (error) {
          this.lastError = formatError(error);
          logger.error({ err: error }, "failed to request pairing code");
        }
      }, 1500);
    }
  }

  private async onConnectionUpdate(update: Partial<ConnectionState>): Promise<void> {
    if (update.qr && this.options.authMode && !this.options.pairingCode) {
      console.log("\nScan this QR code with WhatsApp:\n");
      qrcode.generate(update.qr, { small: true });
    }

    if (update.connection === "open") {
      this.status = "connected";
      this.connectedAt = timestamp();
      this.lastDisconnectAt = undefined;
      this.reconnectAttempt = 0;
      this.immediateReconnectUsed = false;
      this.lastError = undefined;
      logger.info("WhatsApp connected");

      if (this.options.authMode) {
        console.log("WhatsApp auth succeeded.");
        if (process.env.AUTONOMA_WA_EXIT_AFTER_AUTH === "1") {
          setTimeout(() => {
            void this.stop().finally(() => process.exit(0));
          }, 250);
        }
      }
      return;
    }

    if (update.connection !== "close") {
      return;
    }

    this.lastDisconnectAt = timestamp();
    const code = getDisconnectCode(update);
    this.lastError = update.lastDisconnect?.error
      ? formatError(update.lastDisconnect.error)
      : undefined;

    if (this.shuttingDown) {
      this.status = "stopped";
      return;
    }

    if (code === DisconnectReason.loggedOut || code === 401) {
      this.status = "logged_out";
      this.lastError = this.lastError ?? "WhatsApp auth expired. Run `autonoma-wa auth`.";
      createPendingAction(this.db, {
        channel: "internal",
        kind: "whatsapp_auth_expired",
        promptText:
          "WhatsApp auth expired. Run `autonoma-wa auth` in a terminal to re-link the session.",
      });
      logger.warn(this.lastError);
      return;
    }

    if (
      (code === DisconnectReason.restartRequired || code === 515) &&
      !this.immediateReconnectUsed
    ) {
      this.immediateReconnectUsed = true;
      this.reconnectAttempt += 1;
      this.status = "reconnecting";
      logger.warn("WhatsApp restart required; reconnecting immediately");
      await this.connect();
      return;
    }

    this.reconnectAttempt += 1;
    this.status = "reconnecting";
    const backoffMs = Math.min(30_000, 1000 * 2 ** Math.max(0, this.reconnectAttempt - 1));
    logger.warn({ backoffMs, code }, "WhatsApp disconnected; scheduling reconnect");
    await delay(backoffMs);
    await this.connect();
  }

  private async handleSendCommand(
    text: string,
    contextRef?: string,
    pendingAction?: PendingActionRequest,
  ): Promise<DaemonResponse> {
    if (this.status === "auth_required" || this.status === "logged_out") {
      return {
        ok: false,
        status: this.status,
        error: "WhatsApp is not authenticated. Run `autonoma-wa auth` manually in a terminal.",
        daemon: this.snapshot(),
      };
    }

    if (!this.socket || this.status !== "connected") {
      return {
        ok: false,
        status: this.status,
        error: "WhatsApp daemon is not connected.",
        daemon: this.snapshot(),
      };
    }

    const config = loadWhatsAppConfig();
    const remoteJid = resolveRecipientJid(config);

    const pending = createOutboundPendingMessage(this.db, {
      waMessageId: null,
      remoteJid,
      body: text,
      contextRef: contextRef ?? null,
    });

    let resolvedContextRef = contextRef ?? pending.context_ref ?? undefined;
    if (pendingAction) {
      const action = createPendingAction(this.db, {
        channel: "whatsapp",
        contextRef: resolvedContextRef,
        kind: pendingAction.kind,
        promptText: pendingAction.promptText,
        relatedSessionId: pendingAction.relatedSessionId,
        relatedTodoistTaskId: pendingAction.relatedTodoistTaskId,
      });
      resolvedContextRef = action.context_ref ?? action.action_id;
      if (resolvedContextRef !== pending.context_ref) {
        this.db
          .prepare("UPDATE whatsapp_messages SET context_ref = ? WHERE id = ?")
          .run(resolvedContextRef, pending.id);
      }
    }

    const sendOnce = async (): Promise<{ id?: string }> => {
      await this.socket?.sendPresenceUpdate("composing", remoteJid);
      await delay(config.typingDelayMs);
      const result = await this.socket?.sendMessage(remoteJid, { text });
      await this.socket?.sendPresenceUpdate("paused", remoteJid);
      return { id: result?.key.id ?? undefined };
    };

    try {
      let result = await sendOnce();
      if (!result.id) {
        await delay(500);
        result = await sendOnce();
      }

      if (!result.id) {
        throw new Error("WhatsApp send did not return a message id");
      }

      markWhatsAppMessageSent(this.db, pending.id, result.id);
      return {
        ok: true,
        status: "sent",
        messageId: result.id,
        rowId: pending.id,
        contextRef: resolvedContextRef,
        daemon: this.snapshot(),
      };
    } catch (error) {
      const message = formatError(error);
      markWhatsAppMessageFailed(this.db, pending.id, message);
      return {
        ok: false,
        status: "failed",
        error: message,
        rowId: pending.id,
        contextRef: resolvedContextRef,
        daemon: this.snapshot(),
      };
    }
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    this.status = "stopping";

    try {
      (this.socket?.ev as any)?.removeAllListeners?.();
      const transport = this.socket as unknown as { ws?: { close: () => void } } | undefined;
      transport?.ws?.close?.();
    } catch (error) {
      logger.warn({ err: error }, "failed to close WhatsApp socket cleanly");
    }

    await new Promise<void>((resolve) => {
      this.ipcServer?.close(() => resolve());
      if (!this.ipcServer) {
        resolve();
      }
    });

    rmSync(getWhatsAppSocketPath(), { force: true });
    rmSync(getWhatsAppPidPath(), { force: true });
    try {
      this.db.close();
    } catch {
      // ignore
    }
    this.status = "stopped";
  }
}

function parseFlags(argv: string[]): { authMode: boolean; pairingCode: boolean } {
  return {
    authMode: argv.includes("--auth"),
    pairingCode: argv.includes("--pairing-code"),
  };
}

async function main(): Promise<void> {
  ensureWhatsAppHome();
  ensureAuthDirectories();

  const daemon = new WhatsAppDaemon(parseFlags(process.argv.slice(2)));

  const shutdown = async () => {
    await daemon.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await daemon.start();
}

await main();
