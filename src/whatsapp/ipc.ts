import { rmSync } from "node:fs";
import { createServer, Socket } from "node:net";
import pino from "pino";
import type { DaemonCommand, DaemonResponse } from "../contracts/index.ts";
import { getWhatsAppSocketPath } from "./paths.ts";

const logger = pino({ level: process.env.FLITTERBOT_WA_LOG_LEVEL ?? "info" });

type DaemonCommandHandler = (command: DaemonCommand) => Promise<DaemonResponse>;

function writeJson(socket: Socket, payload: DaemonResponse): void {
  // The client may have already gone away (timeout, crash, restart). Writing
  // to a half-closed pipe surfaces as an EPIPE 'error' event on the socket;
  // if we don't guard it here it gets thrown as unhandled and tears down the
  // whole daemon process. The connection-level error handler logs it.
  if (socket.destroyed || socket.writableEnded) {
    return;
  }
  socket.write(`${JSON.stringify(payload)}\n`);
}

export async function createIpcServer(handler: DaemonCommandHandler) {
  const socketPath = getWhatsAppSocketPath();
  rmSync(socketPath, { force: true });

  const server = createServer((socket) => {
    let buffer = "";

    // Without this listener, any socket error (most commonly EPIPE when the
    // client times out and destroys its end while we're still mid-write)
    // becomes an unhandled 'error' event and crashes the daemon.
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE" || error.code === "ECONNRESET") {
        logger.debug({ code: error.code }, "IPC client disconnected before response was written");
        return;
      }
      logger.warn({ err: error }, "IPC socket error");
    });

    socket.setEncoding("utf8");
    socket.on("data", async (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const raw = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);

      try {
        const command = JSON.parse(raw) as DaemonCommand;
        const result = await handler(command);
        writeJson(socket, result);
      } catch (error) {
        writeJson(socket, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          status: "error",
        });
      } finally {
        if (!socket.destroyed) {
          socket.end();
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  return server;
}

export async function sendDaemonCommand(
  command: DaemonCommand,
  options: { timeoutMs?: number; socketPath?: string } = {},
): Promise<DaemonResponse> {
  const socketPath = options.socketPath ?? getWhatsAppSocketPath();
  const timeoutMs = options.timeoutMs ?? 4000;

  return await new Promise<DaemonResponse>((resolve, reject) => {
    const socket = new Socket();
    let buffer = "";

    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out talking to WhatsApp daemon at ${socketPath}`));
    }, timeoutMs);

    socket.setEncoding("utf8");
    socket.connect(socketPath, () => {
      socket.write(`${JSON.stringify(command)}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      clearTimeout(timer);
      const raw = buffer.slice(0, newlineIndex);
      cleanup();
      resolve(JSON.parse(raw) as DaemonResponse);
    });

    socket.on("error", (error) => {
      clearTimeout(timer);
      cleanup();
      reject(error);
    });
  });
}
