import { rmSync } from "node:fs";
import { createServer, Socket } from "node:net";
import type { DaemonCommand, DaemonResponse } from "../contracts/index.ts";
import { getWhatsAppSocketPath } from "./paths.ts";

type DaemonCommandHandler = (command: DaemonCommand) => Promise<DaemonResponse>;

function writeJson(socket: Socket, payload: DaemonResponse): void {
  socket.write(`${JSON.stringify(payload)}\n`);
}

export async function createIpcServer(handler: DaemonCommandHandler) {
  const socketPath = getWhatsAppSocketPath();
  rmSync(socketPath, { force: true });

  const server = createServer((socket) => {
    let buffer = "";

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
        socket.end();
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
